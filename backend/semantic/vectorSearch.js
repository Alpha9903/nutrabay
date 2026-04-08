const fs = require('fs');
const path = require('path');
const axios = require('axios');

const FILE_DIR = path.resolve(__dirname);
const FILE_PATH = path.join(FILE_DIR, 'productVectors.json');
const MODEL = 'text-embedding-3-large';

let index = {};

function toText(p) {
    const parts = [
        String(p.name || ''),
        String(p.description || ''),
        String(p.material || ''),
        Array.isArray(p.tags) ? p.tags.join(' ') : '',
        String(p.category || '')
    ].filter(Boolean);
    return parts.join(' \n ');
}

async function ensureFile() {
    try {
        await fs.promises.mkdir(FILE_DIR, { recursive: true });
        await fs.promises.access(FILE_PATH, fs.constants.F_OK);
    } catch {
        try {
            await fs.promises.writeFile(FILE_PATH, '{}', 'utf8');
        } catch {}
    }
}

async function loadVectorIndex() {
    await ensureFile();
    try {
        const data = await fs.promises.readFile(FILE_PATH, 'utf8');
        index = JSON.parse(data || '{}');
    } catch {
        index = {};
    }
    return index;
}

async function saveVectorIndex() {
    await fs.promises.mkdir(FILE_DIR, { recursive: true });
    const json = JSON.stringify(index, null, 2);
    const tmpPath = path.join(FILE_DIR, `productVectors.json.tmp.${process.pid}.${Date.now()}`);
    try {
        await fs.promises.writeFile(tmpPath, json, 'utf8');
        try {
            await fs.promises.rename(tmpPath, FILE_PATH);
        } catch (e) {
            try {
                await fs.promises.unlink(FILE_PATH);
            } catch {}
            await fs.promises.rename(tmpPath, FILE_PATH);
        }
    } catch (e) {
        try {
            await fs.promises.writeFile(FILE_PATH, json, 'utf8');
            try { await fs.promises.unlink(tmpPath); } catch {}
            return;
        } catch (e2) {
            try { await fs.promises.unlink(tmpPath); } catch {}
            const err = new Error(`Failed to persist vector index to ${FILE_PATH}: ${(e2 && e2.message) ? e2.message : String(e2)}`);
            err.cause = e2;
            throw err;
        }
    }
}

async function getEmbedding(input) {
    const key = process.env.OPENAI_API_KEY;
    const resp = await axios.post('https://api.openai.com/v1/embeddings', { input, model: MODEL }, {
        headers: { Authorization: `Bearer ${key}` },
        proxy: false
    });
    return resp.data.data[0].embedding;
}

async function buildVectorIndex(products) {
    const tasks = [];
    for (const p of products) {
        const pid = String(p.id);
        if (!index[pid]) {
            tasks.push(p);
        }
    }
    const concurrency = 4;
    let i = 0;
    while (i < tasks.length) {
        const batch = tasks.slice(i, i + concurrency);
        await Promise.all(batch.map(async (p) => {
            const text = toText(p);
            const embedding = await getEmbedding(text);
            index[String(p.id)] = {
                embedding,
                metadata: {
                    id: String(p.id),
                    name: p.name,
                    price: p.price,
                    description: p.description || '',
                    material: p.material || '',
                    tags: p.tags || [],
                    category: p.category || '',
                    link: p.link || '',
                    imageUrl: p.imageUrl || ''
                }
            };
        }));
        i += concurrency;
    }
    return index;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function semanticSearch(query, limit = 5) {
    const qEmb = await getEmbedding(String(query || '').slice(0, 4000));
    const scores = [];
    for (const pid of Object.keys(index)) {
        const entry = index[pid];
        if (!entry || !entry.embedding) continue;
        const score = cosine(qEmb, entry.embedding);
        scores.push({ id: pid, score, metadata: entry.metadata });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
}

module.exports = {
    buildVectorIndex,
    saveVectorIndex,
    loadVectorIndex,
    semanticSearch
};
