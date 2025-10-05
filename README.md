# Case Study Backend

![CI](https://github.com/wildanfr19/case-study-backend/actions/workflows/ci.yml/badge.svg)

### PDF Submission Artifact

Workflow otomatis: setiap perubahan `SUBMISSION.md` di branch `main` menghasilkan artifact PDF (lihat tab Actions workflow "Build Submission PDF").

Backend service untuk evaluasi kandidat berdasarkan dua dokumen PDF: CV dan Project Report. Sistem menerima upload dua file, mengekstrak teks, lalu menjalankan evaluasi AI (OpenAI) dengan fallback dan mekanisme robust (mock mode, retry, partial success, synthetic fallback).

## Fitur Utama

- Upload dua PDF (`cv` & `project_report`) sekaligus (multer, size limit, file type filter)
- Ekstraksi teks PDF (pdf-parse) + metadata (pages, word count, preview)
- Penyimpanan job evaluasi di MySQL (status lifecycle: queued -> processing -> completed/failed/canceled)
- Evaluasi AI terpisah CV & Project + agregasi skor akhir (weighted)
- Fallback strategi: mock mode otomatis jika tidak ada API key, fallback partial jika AI gagal, synthetic result jika dua-duanya gagal (opsional)
- Retry eksponensial untuk error transient (rate limit / network)
- Debug endpoints & raw inspection
- Cancel job endpoint
- Script cleanup file upload lama

## Arsitektur Singkat

```
Client -> POST /api/evaluate (multer) -> DB insert job (queued)
                        |--> async processEvaluation()
                                 1. Extract PDF text
                                 2. evaluateCV + evaluateProject (parallel logically / sequential impl)
                                 3. Combine + store JSON result

Client -> GET /api/result/:id -> status + result
```

## Teknologi

- Node.js + Express 4
- MySQL (`mysql2/promise`)
- PDF parsing: `pdf-parse`
- AI: `openai` (Chat Completions)
- Upload: `multer`
- UUID job id

## Endpoint API

| Method | Path                  | Deskripsi                                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------- |
| GET    | `/`                   | Info service                                                               |
| GET    | `/api/health`         | Health check                                                               |
| GET    | `/api/test`           | Test route sederhana                                                       |
| POST   | `/api/upload`         | Upload `cv` + `project_report` (PDF) → dapat document IDs                  |
| POST   | `/api/evaluate`       | Trigger evaluasi (multipart legacy atau JSON {cv_id,project_id,job_title}) |
| GET    | `/api/result/:id`     | Ambil status & hasil job                                                   |
| GET    | `/api/evaluations`    | List semua job (ringkas)                                                   |
| POST   | `/api/test-pdf`       | Tes parsing PDF saja                                                       |
| GET    | `/api/_debug/job/:id` | Lihat raw row (debug)                                                      |
| POST   | `/api/job/:id/cancel` | Batalkan job (queued/processing)                                           |

### Contoh Upload (PowerShell)

```
curl -F "cv=@c:/path/CV.pdf" -F "project_report=@c:/path/Project.pdf" http://localhost:3000/api/evaluate
```

Respons awal:

```
{ "message": "Evaluation job created successfully", "job_id": "<uuid>", "status": "queued" }
```

Polling:

```
curl http://localhost:3000/api/result/<uuid>
```

## Status Job

| Status     | Arti                                  |
| ---------- | ------------------------------------- |
| queued     | Baru dibuat, menunggu dieksekusi      |
| processing | Sedang ekstraksi / evaluasi AI        |
| completed  | Sukses (penuh atau partial)           |
| failed     | Kedua komponen gagal atau error fatal |
| canceled   | Dibatalkan sebelum selesai            |

## Struktur Hasil (Sukses) (Format Akhir Spesifikasi)

```
{
  "id": "...",
  "status": "completed",
  "result": {
    "cv_match_rate": 0.82,
    "cv_feedback": "Strong in backend ...",
    "project_score": 4.5,
    "project_feedback": "Meets chaining requirements ...",
    "overall_summary": "3–5 kalimat ...",
    "cv_evaluation": { ...raw rubric detail... },
    "project_evaluation": { ...raw rubric detail... },
    "issues": [ { component, error } ],
    "_meta": { cv_present: true, project_present: true, retrieved: { ... } }
  }
}
```

## Environment Variables

Lihat `.env.example`. Salin ke `.env` dan isi sesuai kebutuhan.

| Variable                   | Penjelasan                                    |
| -------------------------- | --------------------------------------------- |
| OPENAI_API_KEY             | API key OpenAI (kosong = mock mode)           |
| OPENAI_MODEL               | Model (default gpt-4o-mini)                   |
| AI_FORCE_MOCK              | 1 paksa mock mode                             |
| AI_FALLBACK_TO_MOCK        | 1 fallback ke mock jika gagal panggil model   |
| AI_AUTO_BOTH_FAIL_FALLBACK | 1 buat synthetic result jika dua-duanya gagal |
| AI_RETRY_ATTEMPTS          | Percobaan total (2 = 1 retry)                 |
| AI_RETRY_BASE_DELAY_MS     | Base delay untuk backoff                      |
| DEBUG_AI                   | 1 aktifkan log debug AI                       |
| AI_CV_MAX_CHARS            | Truncation CV text                            |
| AI_PROJECT_MAX_CHARS       | Truncation Project text                       |

## Menjalankan

```
npm install
copy .env.example .env   # PowerShell: Copy-Item .env.example .env
# edit .env (set OPENAI_API_KEY kalau ada)
npm start
```

### Mode Pengembangan / Watch

```
npm run dev
```

### Menjalankan Test

```
npm test
```

Test berjalan dalam mock mode (AI_FORCE_MOCK=1 diset di test files) sehingga tidak butuh API key.

### Menjalankan via Docker

Build & run (compose):

```
docker compose up --build
```

Lalu akses: http://localhost:3000/api/health

Untuk development hot-reload, bisa gunakan volume mapping manual atau jalankan tanpa Docker.

Environment penting (override saat compose):

- `OPENAI_API_KEY` (opsional, tanpa ini mock mode)
- `DB_HOST=db` (sudah diset di compose)

### Build Image Saja

```
docker build -t case-study-backend:latest .
docker run -p 3000:3000 --env-file .env case-study-backend:latest
```

## Cleanup Uploads

Hapus file PDF lebih lama dari N hari (default 2):

```
node scripts/cleanupUploads.js --days=3
```

Integrasi cron (contoh Windows Task Scheduler atau cron Linux) bisa menjalankan script ini harian.

## Cancel Job

```
curl -X POST http://localhost:3000/api/job/<uuid>/cancel
```

Jika status sudah terminal (completed/failed/canceled) akan ditolak.

## Error Handling

- 429 Quota / Rate limit -> fallback (jika diaktifkan) atau gagal
- JSON parse gagal -> fallback atau error parse_error
- Kedua evaluasi gagal -> failed (atau synthetic result jika AI_AUTO_BOTH_FAIL_FALLBACK=1)

## Pengembangan Lanjutan (Ideas)

- Pisah kolom hasil (cv_result, project_result) di DB untuk query cepat
- Antrian terdistribusi (BullMQ / RabbitMQ) untuk skala besar
- Auth + rate limiting di endpoint publik
- Streaming progress events (Server-Sent Events / WebSocket)
- Dashboard admin ringan

## Keamanan

JANGAN commit `.env` dengan API key asli ke repository publik. Gunakan `.env.example` untuk referensi.

## Lisensi

Internal Case Study / Educational.

---

## Approach & Design (Submission Narrative)

### Initial Plan

1. Pisahkan concerns: upload → storage metadata → async evaluation → retrieval context → scoring.
2. Skema status job sederhana dengan extensibility (tambah canceled, index untuk query cepat).
3. Mulai dari pipeline mock agar cepat uji end-to-end sebelum integrasi real LLM.

### Assumptions

- Dokumen rubrik & brief tersedia sebagai PDF terpisah (di folder `docs/`).
- Volume kandidat awal rendah (in-process queue cukup, belum perlu Redis/BullMQ).
- Konsistensi hasil > kreativitas: temperature rendah, parsing ketat.

### Database & Schema

Tables: `documents` (menyimpan semua PDF) & `evaluations` (job metadata, status, result JSON). Index di status & created_at.

### Job Lifecycle

1. POST /api/upload → simpan file → kembalikan IDs.
2. POST /api/evaluate → insert job (queued) → async process: extract text → retrieval → CV eval → Project eval → final synthesis → store result.
3. GET /api/result/:id → polling until completed.

### Retrieval (RAG)

- Ingestion script (`scripts/ingest.js`) membagi PDF ground-truth menjadi chunks dan simpan di `data/vector_store.json`.
- Embedding fallback murah (hash vector) untuk offline mode; bisa otomatis pakai OpenAI embeddings jika API key tersedia.
- Saat evaluasi: ambil top-k chunk (default k=3) per kategori: job_description, rubric_cv, case_brief, rubric_project.
- Context disisipkan ke prompt dalam blok bertagar `[JD_#]`, `[RCV_#]`, `[CB_#]`, `[RP_#]`.

### Prompt & LLM Chaining

1. CV Evaluation: prompt + context job description + CV rubric.
2. Project Evaluation: prompt + context case brief + project rubric.
3. Final Summary: LLM ketiga menggabungkan metrik intermediate → 3–5 kalimat; fallback ke ringkasan deterministik jika error / mock.

### Scoring Computation

Rubrik mengikuti bobot soal, CV 4 parameter → nilai 1–5 lalu dihitung weighted dan dikonversi ke 0–1 (×0.2). Project 5 parameter weighted jadi 1–5.

### Resilience & Error Handling

- Retry eksponensial untuk panggilan LLM (rate_limit, timeout, network) dengan batas percobaan.
- Fallback berlapis: mock mode (tanpa API key), fallback per-komponen, synthetic result bila dua evaluasi gagal.
- JSON parsing multi-strategy (fence removal, slice braces, regex fallback) + logging attempts (DEBUG_AI).

### Edge Cases

- File bukan PDF → ditolak di multer filter.
- Hanya salah satu evaluasi gagal → partial success + issues[].
- Rate limit 429 berturut → fallback mock.
- Retrieval store kosong → placeholder `[NO_STORE]` tidak menghentikan evaluasi.
- Panjang dokumen ekstrem → truncation + meta truncated flag.

### Future Improvements

- Ganti in-process job menjadi distributed queue (BullMQ) untuk scale.
- Simpan embedding di DB / vector engine (Qdrant/Chroma) + semantic filtering lanjutan.
- Tambah auth, per-user quota & audit logging.
- Streaming progress via SSE / WebSocket.
- Per-parameter confidence scores.

### Reflection

Apa yang bekerja baik: fallback multi-lapis → selalu ada hasil; pipeline bisa upgrade ke vector DB tanpa mengubah kontrak API.
Yang belum optimal: retrieval masih simple (hash embedding); final summary masih satu shot tanpa evaluasi linting; tidak ada test integrasi PDF real.

---

## Ingestion Repro Steps

Letakkan PDF ground-truth di folder `docs/` lalu jalankan:

```
node scripts/ingest.js ./docs/job_description.pdf:job_description ./docs/case_brief.pdf:case_brief ./docs/rubric_cv.pdf:rubric_cv ./docs/rubric_project.pdf:rubric_project
```

Hasil akan tersimpan di `data/vector_store.json`.

## Testing (Mock Mode)

Set environment:

```
set AI_FORCE_MOCK=1   # Windows PowerShell: $env:AI_FORCE_MOCK="1"
npm test
```
