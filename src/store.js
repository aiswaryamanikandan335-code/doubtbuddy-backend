const { FieldValue } = require('firebase-admin/firestore');

const BATCH_SIZE = 200;
const MAX_CHUNKS_SCANNED = 2000; // in-memory search limit per student

// Firestore layout (everything is private to one user):
//   users/{uid}/notes/{noteId}    { fileName, pageCount, chunkCount, storagePath, createdAt }
//   users/{uid}/chunks/{chunkId}  { noteId, fileName, page, text, embedding(768 numbers) }
//   users/{uid}/doubts/{doubtId}  { question, answer, sources, conversationId, createdAt }
//
// useVectorIndex = true  -> Firestore vector search (needs the index from deploy.sh)
// useVectorIndex = false -> embeddings stored as plain arrays and compared here (free, no index needed)
function createStore(db, { useVectorIndex = false } = {}) {
  const user = (uid) => db.collection('users').doc(uid);

  return {
    newNoteId(uid) {
      return user(uid).collection('notes').doc().id;
    },

    async saveNote(uid, note, chunks) {
      for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
        const batch = db.batch();
        for (const chunk of chunks.slice(start, start + BATCH_SIZE)) {
          batch.set(user(uid).collection('chunks').doc(), {
            noteId: note.id,
            fileName: note.fileName,
            page: chunk.page,
            text: chunk.text,
            embedding: useVectorIndex ? FieldValue.vector(chunk.embedding) : chunk.embedding,
          });
        }
        await batch.commit();
      }
      // Written last, so a note only "exists" once all of its chunks are searchable.
      await user(uid).collection('notes').doc(note.id).set({
        fileName: note.fileName,
        pageCount: note.pageCount,
        chunkCount: chunks.length,
        storagePath: note.storagePath,
        createdAt: new Date(),
      });
    },

    async nearestChunks(uid, vector, limit) {
      if (!useVectorIndex) {
        const all = await user(uid).collection('chunks')
          .select('fileName', 'page', 'text', 'embedding')
          .limit(MAX_CHUNKS_SCANNED)
          .get();
        return all.docs
          .map((doc) => {
            const data = doc.data();
            const embedding = Array.isArray(data.embedding) ? data.embedding : data.embedding.toArray();
            return { fileName: data.fileName, page: data.page, text: data.text, distance: cosineDistance(vector, embedding) };
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, limit);
      }

      const snapshot = await user(uid).collection('chunks')
        .findNearest({
          vectorField: 'embedding',
          queryVector: vector,
          limit,
          distanceMeasure: 'COSINE',
          distanceResultField: 'distance',
        })
        .get();
      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return { fileName: data.fileName, page: data.page, text: data.text, distance: data.distance };
      });
    },

    // A random spread of chunks for quiz generation (embeddings are not downloaded).
    async sampleChunks(uid, count) {
      const snapshot = await user(uid).collection('chunks').select('fileName', 'page', 'text').limit(300).get();
      const all = snapshot.docs.map((doc) => doc.data());
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      return all.slice(0, count);
    },

    async saveDoubt(uid, doubt) {
      const createdAt = new Date();
      const ref = await user(uid).collection('doubts').add({ ...doubt, createdAt });
      return { id: ref.id, createdAt };
    },

    async recentDoubts(uid, limit) {
      const snapshot = await user(uid).collection('doubts').orderBy('createdAt', 'desc').limit(limit).get();
      return snapshot.docs.map((doc) => toDoubt(doc));
    },

    async conversationHistory(uid, conversationId, limit) {
      const snapshot = await user(uid).collection('doubts').where('conversationId', '==', conversationId).limit(50).get();
      return snapshot.docs
        .map((doc) => toDoubt(doc))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit);
    },
  };
}

// 0 = same meaning, 1 = unrelated, 2 = opposite (same scale as Firestore's COSINE distance).
function cosineDistance(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toDoubt(doc) {
  const data = doc.data();
  const createdAt = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt);
  return {
    id: doc.id,
    question: data.question,
    answer: data.answer,
    sources: data.sources || [],
    conversationId: data.conversationId,
    createdAt: createdAt.toISOString(),
  };
}

module.exports = { createStore, cosineDistance };
