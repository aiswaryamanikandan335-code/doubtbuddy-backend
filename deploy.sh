#!/usr/bin/env bash
# Sets up Google Cloud for DoubtBuddy and deploys the API to Cloud Run.
# Run in Google Cloud Shell from this folder:   bash deploy.sh
# Safe to run again (it skips anything that already exists and redeploys the code).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"             # Cloud Run, Firestore and Storage (Mumbai)
VERTEX_LOCATION="${VERTEX_LOCATION:-us-central1}"  # Gemini models
SERVICE="doubtbuddy-api"
BUCKET="${PROJECT_ID}-doubtbuddy-notes"
SA_NAME="doubtbuddy-api"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "No project selected. Run:  gcloud config set project YOUR_FIREBASE_PROJECT_ID" >&2
  exit 1
fi
echo "==> Project: ${PROJECT_ID}   Region: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enabling APIs (first time takes ~1 minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com iam.googleapis.com

echo "==> Firestore database"
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --database="(default)" --location="${REGION}" --type=firestore-native
fi

echo "==> Firestore vector index (for searching notes)"
gcloud firestore indexes composite create \
  --collection-group=chunks \
  --query-scope=COLLECTION \
  --field-config='field-path=embedding,vector-config={"dimension":"768","flat":"{}"}' \
  --database="(default)" 2>/dev/null || echo "    (index already exists)"

echo "==> Storage bucket for PDFs"
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location="${REGION}" \
    --uniform-bucket-level-access --public-access-prevention
fi

echo "==> Service account with only the permissions the API needs"
if ! gcloud iam service-accounts describe "${SA}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" --display-name="DoubtBuddy API"
  sleep 10 # let the new account propagate
fi
for ROLE in roles/aiplatform.user roles/datastore.user; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA}" \
    --role="${ROLE}" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" \
  --role=roles/storage.objectAdmin >/dev/null

echo "==> Allow Cloud Build to build the container"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/run.builder --condition=None >/dev/null

echo "==> Deploying to Cloud Run (3-5 minutes)"
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SA}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "PROJECT_ID=${PROJECT_ID},STORAGE_BUCKET=${BUCKET},VERTEX_LOCATION=${VERTEX_LOCATION},VECTOR_SEARCH=firestore"

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo
echo "=============================================================="
echo " DoubtBuddy API is live:  ${URL}"
echo " Health check:            ${URL}/healthz"
echo " Paste the URL into Unity: Assets/DoubtBuddy/Config/AppConfig -> Backend Base Url"
echo "=============================================================="
