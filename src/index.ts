import { Container, getRandom } from "@cloudflare/containers";
import { sValidator } from "@hono/standard-validator";

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import z from "zod";

const INSTANCE_COUNT = 50;

// Transient container/YouTube failures worth retrying on a *different* random
// container instance: each instance is a separate Cloudflare container with its
// own egress, so a retry elsewhere can dodge an IP-level bot check or rate
// limit. 4xx that are about the request itself (400/404) are never retried.
const RETRY_BACKOFF_MS = [1500, 3000];

function isRetryableContainerFailure(status: number, body: string): boolean {
	if (status === 429 || status >= 500) {
		return true;
	}
	if (status === 403) {
		return /sign in|not a bot/i.test(body);
	}
	return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ContainerResponse =
	| {
			success: true;
			transcript: string;
			metadata?: {
				subtitleType?: "manual" | "auto" | "asr";
				language?: string;
				description?: string;
				view_count?: number;
				author?: string;
			};
	  }
	| {
			success: false;
			error: string;
			code?: string;
	  };

export class MyContainer extends Container<CloudflareBindings> {
	defaultPort = 3000;
	sleepAfter = "1m";

	constructor(
		ctx: ConstructorParameters<typeof Container>[0],
		env: CloudflareBindings,
	) {
		super(ctx, env);
		// Lets the container transcribe the audio of videos without captions.
		// Without the secret it answers 404 "No subtitles" as before.
		if (env.CF_API_TOKEN) {
			this.envVars = {
				CF_API_TOKEN: env.CF_API_TOKEN,
				CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
			};
		}
	}
}

function extractVideoId(url: string): string {
	const match = url.match(
		/.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|shorts\/|live\/)([^#&?]*).*/,
	);
	if (match !== null && match[1].length === 11) {
		return match[1];
	} else {
		throw new Error("Failed to get youtube video id from the url");
	}
}

async function loadURLMeta(env: CloudflareBindings, url: string) {
	const params = {
		url: url,
	};
	// Prepare the request to the browser worker
	const searchParams = new URLSearchParams(params);
	const requestUrl = `https://browser-worker.bruce-waynezu.workers.dev/?${searchParams.toString()}`;

	// Read response as text first to avoid deserialization issues
	let text: string | undefined;
	try {
		// @ts-expect-error
		const response = await env.BROWSER_WORKER.internalFetch(
			new Request(requestUrl),
		);

		if (!response.ok) {
			throw new Error(
				`Failed to get URL: ${response.status} ${response.statusText}`,
			);
		}

		// Read response as text first to avoid deserialization issues
		text = await response.text();
		if (!text) {
			text = '[{ "content": { "og_image": "", "title": "" } }]';
		}
		const d: { content: { og_image: string; title: string } }[] =
			JSON.parse(text);
		const content = d[0]?.content || {};

		return {
			thumbnail_url: content.og_image,
			title: content.title,
		};
	} catch (e) {
		console.error({
			message: "Failed to parse metadata response",
			text: text || "No text",
			error: e,
		});
		return {
			thumbnail_url: "",
			title: "",
		};
	}
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Middleware to verify the bearer token
app.use(
	"/*",
	bearerAuth<{ Bindings: CloudflareBindings }>({
		verifyToken: (token, c) => {
			const ok = token === c.env.API_KEY;
			if (!ok) {
				console.warn({
					message: "Bearer auth failed",
					path: c.req.path,
					tokenPrefix: token.slice(0, 6),
					tokenLength: token.length,
				});
			}
			return ok;
		},
	}),
);

const schema = z.object({
	url: z.url(),
	lang: z.string().optional(), // If omitted, container will auto-detect
});

app.get(
	"/",
	sValidator("query", schema, (result, c) => {
		if (!result.success) {
			console.warn({
				message: "Query schema validation failed",
				path: c.req.path,
				query: c.req.query(),
				issues: result.error,
			});
		}
	}),
	async (c) => {
		try {
			const { url, lang } = c.req.valid("query");

			// Build URL with query params
			const transcriptUrl = new URL("/transcript", "http://container");
			transcriptUrl.searchParams.set("url", url);
			// Only set lang if explicitly provided
			if (lang) {
				transcriptUrl.searchParams.set("lang", lang);
			}

			let response: Response | undefined;
			let text = "";
			const maxAttempts = RETRY_BACKOFF_MS.length + 1;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				// Re-pick a random container instance on every attempt so a retry
				// lands on different container egress.
				const container = await getRandom(c.env.MY_CONTAINER, INSTANCE_COUNT);

				console.log({
					message: "Fetching transcript from container",
					transcriptUrl: transcriptUrl.toString(),
					attempt,
					maxAttempts,
				});
				response = await container.fetch(transcriptUrl.toString());
				text = await response.text();
				if (response.ok) {
					console.log({
						message: "Response from container",
						status: response.status,
						statusText: response.statusText,
						ok: response.ok,
						headers: Object.fromEntries(response.headers),
						attempt,
					});
					break;
				}

				console.error({
					message: "Response from container",
					status: response.status,
					statusText: response.statusText,
					ok: response.ok,
					headers: Object.fromEntries(response.headers),
					body: text,
					attempt,
				});

				const backoffMs = RETRY_BACKOFF_MS[attempt - 1];
				if (
					attempt >= maxAttempts ||
					!isRetryableContainerFailure(response.status, text)
				) {
					break;
				}

				console.warn({
					message: "Retrying transcript fetch on a new container instance",
					url,
					status: response.status,
					attempt,
					nextAttempt: attempt + 1,
					maxAttempts,
					backoffMs,
					body: text.slice(0, 500),
				});
				await sleep(backoffMs);
			}

			if (!response) {
				return c.json({ error: "Container request never ran" }, 500);
			}

			let data: ContainerResponse;
			try {
				data = JSON.parse(text);
			} catch {
				return c.json(
					{ error: text || "Container returned invalid response" },
					500,
				);
			}

			const status = response.status as ContentfulStatusCode;

			if (data.success === false) {
				return c.json({ error: data.error, code: data.code }, status);
			}

			if (typeof data.transcript !== "string") {
				return c.json(
					{ error: "Container returned malformed success response" },
					500,
				);
			}

			const { thumbnail_url, title } = await loadURLMeta(c.env, url);
			const metadata: {
				thumbnail_url?: string;
				title: string;
				source: string;
				// "asr" when the text was transcribed from the audio
				subtitle_type?: string;
				language?: string;
				description?: string;
				view_count?: number;
				author?: string;
			} = {
				source: extractVideoId(url),
				thumbnail_url,
				title,
				subtitle_type: data.metadata?.subtitleType,
				language: data.metadata?.language,
				description: data.metadata?.description,
				view_count: data.metadata?.view_count,
				author: data.metadata?.author,
			};

			return c.json({ content: data.transcript, metadata }, status);
		} catch (e) {
			if (e instanceof Error) {
				console.error(e);
				return c.json({ error: e.message }, 500);
			}
			console.error(e);
			return c.json({ error: "Unknown error" }, 500);
		}
	},
);

export default app;
