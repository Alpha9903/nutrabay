const fs = require('fs');
const path = require('path');

const memoryCache = Object.create(null);
let saveTimer = null;
let saving = false;
const FILE_DIR = path.resolve(__dirname);
const FILE_PATH = path.join(FILE_DIR, 'sessionMemory.json');

async function ensureFile() {
    try {
        await fs.promises.mkdir(FILE_DIR, { recursive: true });
        await fs.promises.access(FILE_PATH, fs.constants.F_OK);
    } catch (e) {
        await fs.promises.writeFile(FILE_PATH, '{}', 'utf8');
    }
}

async function loadMemory() {
    await ensureFile();
    try {
        const data = await fs.promises.readFile(FILE_PATH, 'utf8');
        const json = JSON.parse(data || '{}');
        Object.assign(memoryCache, json);
        return memoryCache;
    } catch (e) {
        await fs.promises.writeFile(FILE_PATH, '{}', 'utf8');
        return memoryCache;
    }
}

async function saveMemory() {
    if (saving) return;
    saving = true;
    try {
        const json = JSON.stringify(memoryCache, null, 2);
        await fs.promises.writeFile(FILE_PATH, json, 'utf8');
    } finally {
        saving = false;
    }
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        await saveMemory();
    }, 2000);
}

module.exports = { memoryCache, loadMemory, saveMemory, scheduleSave };
