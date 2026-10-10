# DoubtBuddy API

Backend for the DoubtBuddy Unity app. It runs in two modes:

| Piece | **FREE mode** (recommended now) | Google Cloud mode (needs Blaze billing) |
|---|---|---|
| API server (Node.js + Express) | **Render free** | Cloud Run |
| Login check | Firebase Auth | Firebase Auth |
| AI answers + quizzes | **Gemini API free tier** (`gemini-3.5-flash-lite`, falls back to `gemini-3.8-flash`) | Gemini on Vertex AI |
| Note search (embeddings) | Gemini API `gemini-embedding-001` | Vertex AI `gemini-embedding-001` |
| Vector DB | Firestore (vectors compared in the server) | Firestore vector index |
| Doubts, notes, chunks | **Firestore (Spark free quota)** | Firestore |
| PDF files | not kept (only the text) | Cloud Storage |

Keys stay on the server only. The Unity app only sends the student's Firebase login token.

---

## FREE deployment (Render + Firebase Spark + Gemini API free tier)

Free-tier limits: Render sleeps after 15 min idle (first request then takes ~50 s). Gemini free tier allows a limited number of requests per minute/day, and Google may use free-tier prompts to improve its products. Firestore's free quota allows 50k reads/day.

### 1. Firestore database (Firebase console, project `doubtbuddy-83cc1`)
**Databases and storage â†’ Firestore â†’ Create database** â†’ *Standard edition* â†’ location **asia-south1 (Mumbai)** â†’ **Start in production mode** â†’ **Create**.

### 2. Service-account key (lets the server use Auth + Firestore)
**âš™ï¸ Settings â†’ Project settings â†’ Service accounts â†’ Generate new private key â†’ Generate key**. A `.json` file downloads. Keep it private.

### 3. Gemini API key (free)
<https://aistudio.google.com/apikey> â†’ **Create API key** â†’ choose project **doubtbuddy-83cc1** â†’ copy the key.
Do **not** enable billing on that project, so it stays on the free tier.

### 4. Upload code to GitHub
Create a public repo `doubtbuddy-backend` and upload everything from `D:\DoubtBuddyBackend_GitHub` (no keys are in it).

### 5. Render
**New â†’ Web Service â†’ Public Git Repository** â†’ paste the repo URL â†’
- Name: `doubtbuddy-api`, Region: **Singapore**, Branch: `main`
- Build Command: `npm install`  Start Command: `npm start`  Instance type: **Free**
- **Environment variables**: copy from `render-env.txt` (`GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`)
- **Deploy**. Open `https://<your-app>.onrender.com/healthz` â†’ `{"ok":true}`.

### 6. Unity
`AppConfig` â†’ **Backend Base Url** = your Render URL, **Use Mock Backend** â˜ off.

---

# Google Cloud mode (optional, needs Blaze billing)

## Endpoints (all need `Authorization: Bearer <Firebase ID token>`)
| Method | Path | What it does |
|---|---|---|
| POST | `/api/doubts/ask` | `{question, conversationId}` â†’ AI answer + source PDF/page, saved to history |
| GET | `/api/doubts/recent?limit=20` | Student's recent doubts |
| POST | `/api/notes/upload` | multipart `file` (PDF â‰¤ 20 MB, â‰¤ 300 pages) â†’ text extracted per page, embedded, stored |
| GET | `/api/quiz?count=10` | Multiple-choice quiz generated from the student's notes |
| GET | `/healthz` | Public health check |

Errors are always `{"error": "message for the student"}`.

---

## Deploy (about 15 minutes, all in the browser)

### 1. One Firebase project = one Google Cloud project
Use the **same Firebase project** you create for the Unity app's `google-services.json` (e.g. *DoubtBuddy*). Every Firebase project is also a Google Cloud project.

1. In <https://console.firebase.google.com>, open the project and click **Upgrade** (bottom left) â†’ **Blaze (pay as you go)**.
   Cloud Run, Vertex AI and Cloud Build need billing. Small student usage usually stays in the free tiers or costs a few rupees.
   *Tip:* in Google Cloud Console â†’ **Billing â†’ Budgets & alerts**, set a budget (e.g. â‚¹500) so you get an email before spending more.
2. Note the **Project ID** (Project settings â†’ General), e.g. `doubtbuddy-1a2b3`.

### 2. Open Cloud Shell
1. Go to <https://console.cloud.google.com> and pick the same project at the top.
2. Click the **Cloud Shell** icon `>_` (top right). A terminal opens at the bottom.

### 3. Upload and deploy
1. In Cloud Shell click **â‹® (More) â†’ Upload** â†’ choose `D:\DoubtBuddyBackend\DoubtBuddyBackend.zip`.
2. Run (replace the project ID):
   ```bash
   mkdir -p doubtbuddy-api && cd doubtbuddy-api
   unzip -o ~/DoubtBuddyBackend.zip
   gcloud config set project YOUR_PROJECT_ID
   bash deploy.sh
   ```
3. If asked *"Do you want to continue (Y/n)?"* or to create an Artifact Registry repository, press **Y**.
4. At the end it prints:
   ```
   DoubtBuddy API is live:  https://doubtbuddy-api-xxxxx-el.a.run.app
   ```
   Open `<that URL>/healthz` in a browser. You should see `{"ok":true}`.

### 4. Connect the Unity app
1. Unity â†’ `Assets/DoubtBuddy/Config/AppConfig`:
   - **Backend Base Url** = the URL from step 3 (no `/` at the end)
   - **Use Mock Backend** = â˜ unticked
2. Select **App** in the Hierarchy â†’ **AuthManager** â†’ **Ui Only Mode** = â˜ unticked (real Firebase login is required, because the API checks the token).
3. Play â†’ Sign up â†’ Upload Notes (a text PDF) â†’ Ask a Doubt about it. The answer shows *Source: yourfile.pdf, page N*.

### Updating after code changes
Zip again, upload, then in Cloud Shell: `cd ~/doubtbuddy-api && unzip -o ~/DoubtBuddyBackend.zip && bash deploy.sh`.

---

## Local development (optional)
Needs Node 20+ and the gcloud CLI.
```bash
npm install
npm test                                  # runs with fake services, no cloud needed
gcloud auth application-default login     # lets local code call Vertex AI / Firestore
cp .env.example .env                      # then fill in PROJECT_ID and STORAGE_BUCKET
npm run dev
```

## Settings (environment variables)
| Variable | Default | Notes |
|---|---|---|
| `PROJECT_ID` | â€“ | set by deploy.sh |
| `STORAGE_BUCKET` | â€“ | set by deploy.sh (`<project>-doubtbuddy-notes`) |
| `VERTEX_LOCATION` | `us-central1` | where Gemini runs |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | change if Google retires it |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.8-flash` | used when the main model is busy |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | output size fixed at 768 to match the index |

To change one without redeploying code:
`gcloud run services update doubtbuddy-api --region asia-south1 --update-env-vars GEMINI_MODEL=...`

## Troubleshooting
| Symptom | Fix |
|---|---|
| App says "Your session has expired" | The app must use real Firebase login (Ui Only Mode off) from the **same** Firebase project. |
| `deploy.sh`: billing / permission error | Project must be on Blaze, and you must be Owner of the project. |
| Upload says "No readable text found" | The PDF is scanned images. Use a text PDF (you can select text in it). |
| 500 errors right after first deploy | The vector index can take a few minutes to build. Check **Firestore â†’ Indexes**, wait for it to be ready. |
| "Model not found" in logs | Set `GEMINI_MODEL` to a current model (see Vertex AI â†’ Model Garden). |
| See server logs | Cloud Console â†’ **Cloud Run â†’ doubtbuddy-api â†’ Logs**. |

