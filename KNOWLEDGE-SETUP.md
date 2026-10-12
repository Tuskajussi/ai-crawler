# Knowledge and embeddings

Open **Knowledge** to turn a selected file or pasted text into searchable chunks. Each saved chunk has its own embedding, source name and location. This library belongs to the local Crawlspace copy; it is separate from workflow models and decision routing.

## First use

1. Choose an **Embedding model**, enter its settings and save. Configuration readiness does not test the provider.
2. Paste text or choose a file, then select **Preview chunks**. Preparation runs locally and does not contact an embedding provider.
3. Review the chunk list and destination. For a cloud provider, explicitly approve sending this source's chunks, then select **Create embeddings**.
4. After creation completes, enter a text query under **Search your chunks**. Cloud search also requires approval because the provider embeds the query.
5. Results show source lines, PDF pages or timestamps. **Download chunk** retrieves the saved text, page, image or clip. A source's export button downloads JSON containing vectors, locations and local chunk download links.

Cloud approval applies to that action. Indexing uses one request per chunk, and searching uses one request for the query. Cancelling stops future requests and waits for active work to stop; already completed requests may still be billable. A source appears in the library only when every chunk succeeds. Failed or cancelled jobs require a new preview.

## Providers

| Connection | Content | Setup |
| --- | --- | --- |
| Google Gemini API | Text, PDFs, images, audio and video | `gemini-embedding-2`; API key in a server environment variable, normally `GEMINI_API_KEY`. |
| Google Vertex AI | Text, PDFs, images, audio and video | `gemini-embedding-2`; Google Cloud project, EU/US/global location and Application Default Credentials. |
| Compatible embedding server | Text | Your model's exact ID, `/v1` base URL and supported vector dimensions. Localhost and private LAN addresses are supported. |

The Google adapters use the native embedding APIs, with retrieval formatting and validated, normalized vectors. They do not use a chat endpoint. Google describes the model's common embedding space and modality limits in its [multimodal guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings).

### Gemini API

Set the key in the shell that starts Crawlspace:

```powershell
$env:GEMINI_API_KEY = "your-key"
npm run dev
```

Select **Google Gemini API**, leave the key field as `GEMINI_API_KEY`, and save. Enter only the environment variable name in the browser. Restart the server after changing its environment. Google API credentials and billing are separate from the accounts used by review agents. See [Google's embedding guide](https://ai.google.dev/gemini-api/docs/embeddings).

### Vertex AI

Provide ADC to the server's OS user, for example through `gcloud auth application-default login`, then select **Google Vertex AI**, enter the project ID and choose a location. The project needs the relevant API access, permissions and billing. Credential discovery and refresh use Google's auth library and happen only when an embedding or search is requested. A valid configuration does not establish actual access. See [Google's ADC setup](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc).

### Your local machines

Run a dedicated embedding model on a local inference server. A chat or decision model is usable here only if its server actually supports `/v1/embeddings` for that model.

For example, [Ollama's EmbeddingGemma](https://ollama.com/library/embeddinggemma) is a text embedding model:

```powershell
ollama pull embeddinggemma
```

With Ollama running, select **Compatible embedding server**, **Local machine or private network**, model `embeddinggemma`, URL `http://127.0.0.1:11434/v1` and 768 dimensions. Leave the API key variable empty if the server does not require authentication. Ollama documents its [compatible embedding endpoint](https://docs.ollama.com/api/openai-compatibility).

Use the other machine's private IP in the URL when hosting remotely; localhost always means the Crawlspace controller. Protect remote inference using your private network or tunnel. Local destinations require localhost or a private literal IP. Cloud destinations require HTTPS and explicit upload approval. Redirects are rejected.

The selected dimensions must match the actual returned vectors. Chunk size must fit the embedding model's context; reduce it under **Chunk options** for models with smaller input windows. Compatible providers support text only in this version; there is no automatic OCR, transcription or cloud fallback for them.

## Chunk preparation

| Source | Saved chunks and locations |
| --- | --- |
| UTF-8 text, Markdown, CSV, JSON, HTML, XML and logs | Up to 1,800 UTF-16 characters, with 200-character overlap by default; paragraph/line boundaries are preferred. Character offsets and line numbers refer to the decoded source. |
| PDF | One page per chunk, with page numbers. Password-protected or unreadable PDFs are rejected. |
| Image | One image per chunk. PNG/JPEG are retained; WebP/BMP/HEIF/AVIF are converted to PNG. |
| Audio | The first audio track becomes 16 kHz mono WAV clips, 150 seconds by default, with timestamps. |
| Video | The first video track becomes silent MP4 clips, 60 seconds by default; the first audio track is also saved as separate timestamped WAV chunks when present. Video is normalized to 24 fps and at most 1280 pixels per side. |

Audio/video and image conversion require `ffmpeg` and `ffprobe` on the controller's PATH. Restart Crawlspace after installing them. Text, PDFs and original PNG/JPEG inputs do not require FFmpeg. Common supported media extensions include MP3, WAV, M4A, FLAC, OGG, MP4, MOV, MPEG and WebM; the installed FFmpeg build must decode the selected format.

Very dense PDF pages can exceed Gemini's 8,192-token input window. Google documents silent truncation beyond that window, including extracted/OCR text. One page per chunk reduces this risk but does not guarantee complete coverage; split dense pages or provide smaller text excerpts. The defensive `autoTruncate: false` setting is not a guarantee across multimodal APIs. See [Google's PDF processing details](https://ai.google.dev/gemini-api/docs/embeddings#how-the-model-processes-pdfs).

## Storage and limits

- At most 100 MiB per upload, 100 chunks per source, 100 saved sources and 1,000 saved chunks.
- Saved content is capped at 1 GiB; each prepared media chunk is capped at 12 MiB.
- Up to two previews, with a combined 256 MiB allowance; previews expire after 15 minutes and are lost on restart.
- One knowledge upload/preparation, indexing job or search runs at a time. Indexing is sequential and has no automatic retries. Knowledge requests use their own service; workflow endpoint slots do not coordinate them, so avoid heavy simultaneous work on a constrained inference machine.
- Provider requests have a configurable deadline. Media preparation has a 180-second budget, with local conversion cancellation and cleanup. PDF parsing runs in a separate worker with a bounded JavaScript heap; cancellation and deadlines terminate that worker and wait for it to exit. This is a processing bound rather than an OS sandbox.

The default data directory is `.crawlspace/knowledge/`, alongside the workflow state. `index.json` holds configuration, text chunks and vectors, with a validated `.bak` recovery snapshot. Generated source directories hold media chunks. Saves publish atomically; interrupted jobs do not appear as partial sources. Startup removes abandoned generated source directories. Back up this whole directory when the library matters. Exports include vectors and local download links, rather than an archive of media files.

Changing the provider, endpoint, model, dimensions or retrieval formatting creates a separate embedding space. Old sources remain visible, but search uses only matching sources. Switch back to their original settings or index them again with the new model. Identical content, title and chunk plan in the same space is rejected as a duplicate.

Deleting a source removes its saved chunks and vectors, including the recovery backup's copy, and leaves the original file untouched. Local media downloads reject links and oversized or replaced files. Storage paths must use real directories without symlinks or Windows junctions.

This is a bounded local library using cosine search over saved vectors. It does not yet provide automatic folder watching, workflow-agent retrieval tools, transcripts, generated captions, a distributed vector database or automatic migration between embedding spaces. No credentials or source content are sent by ordinary status polling or by preview preparation.

## Verification

```powershell
npm test
npm run test:knowledge
npm run build
```

Tests cover actual local chunk preparation, native/compatible request contracts with mocked transports, cloud consent, cancellation/draining, atomic persistence, recovery, downloads and search. Browser checks include all five media types, provider configuration, progress, deletion, mobile layout and a real UI-to-local-API flow against a fixture embedding server. They do not establish Google account entitlement, local model retrieval quality or performance on the three intended machines. Commission those connections with a small representative source before adding a larger collection.
