To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

open http://localhost:3000

## Videos without captions

When a video lists no caption track in any language, `/transcript` downloads
its audio and transcribes it with Cloudflare Workers AI Whisper
(`@cf/openai/whisper-large-v3-turbo`, about $0.03 per hour of audio). The
response then has `metadata.subtitleType: "asr"`. This needs two environment
variables, which the Worker passes in from its `CF_ACCOUNT_ID` var and
`CF_API_TOKEN` secret (an API token made from the dashboard's "Workers AI"
template):

```sh
docker run --rm -p 3000:3000 -e CF_ACCOUNT_ID=... -e CF_API_TOKEN=... <image>
curl 'http://localhost:3000/transcript?url=https://www.youtube.com/watch?v=ElAoPhaOhQ0'
```

Without them, such videos get `404 No subtitles available for this video`.
Videos over 2 hours, and live streams that have not ended, are not
transcribed.
