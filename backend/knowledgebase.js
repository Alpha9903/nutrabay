// yeh file saare product catalog + website knowledge base ka core logic handle karti hai
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const botConfig = require('./config/bot_prompts');
// Removed redundant scrape_sources.js

// Supabase connection details (knowledge base ko DB se load/store karne ke liye)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const BOT_ID = process.env.BOT_ID;
const BRAND_NAME = botConfig.company.company_name || '/PHD/ - Proven Honest Derma';
const BRAND_WEBSITE = String(botConfig.company.website_url || 'https://phdbeauty.com').replace(/\/$/, '');
const WEBSITE_PATHS = botConfig.company.website_paths || {};
const PRODUCT_DATA = botConfig.company.product_data || {};
const PRODUCT_DATA_ENABLED = PRODUCT_DATA.enabled !== false;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PRODUCT_BASE_URL = String(PRODUCT_DATA.baseUrl || BRAND_WEBSITE).replace(/\/$/, '');
const PRODUCTS_JSON_PATH = PRODUCT_DATA_ENABLED && PRODUCT_DATA.productsJsonPath ? PRODUCT_DATA.productsJsonPath : null;
const RECOMMENDATIONS_PATH = PRODUCT_DATA_ENABLED && PRODUCT_DATA.recommendationsPath ? PRODUCT_DATA.recommendationsPath : null;
const PRODUCT_PATH_TEMPLATE = PRODUCT_DATA_ENABLED && PRODUCT_DATA.productPath ? PRODUCT_DATA.productPath : null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const DIRECT_HTTP_OPTIONS = { proxy: false };

function normalizeSpaces(value) {
    const s = String(value || '');
    let out = '';
    let prevSpace = false;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        const isSpace = ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
        if (isSpace) {
            if (!prevSpace) out += ' ';
            prevSpace = true;
        } else {
            out += ch;
            prevSpace = false;
        }
    }
    return out.trim();
}

function buildBrandAbsoluteUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    if (s.startsWith('/')) return `${BRAND_WEBSITE}${s}`;
    return `${BRAND_WEBSITE}/${s}`;
}

function getWebsitePathConfig() {
    return {
        pricing: WEBSITE_PATHS.pricing || '/pricing',
        about: WEBSITE_PATHS.about || '/about-us',
        contact: WEBSITE_PATHS.contact || '/pages/contact',
        services: WEBSITE_PATHS.services || '/collections/all',
        shipping: WEBSITE_PATHS.shipping || WEBSITE_PATHS.shipping_policy || '/policies/shipping-policy',
        returns: WEBSITE_PATHS.returns || WEBSITE_PATHS.return || WEBSITE_PATHS.return_policy || WEBSITE_PATHS.exchange_policy || '/policies/refund-policy',
        privacy: WEBSITE_PATHS.privacy || WEBSITE_PATHS.privacy_policy || '/policies/privacy-policy',
        terms: WEBSITE_PATHS.terms || '/policies/terms-of-service',
        faq: WEBSITE_PATHS.faq || '',
        orderTracking: WEBSITE_PATHS.order_tracking || '/pages/order-tracking'
    };
}

function getConfiguredKnowledgeUrls() {
    const paths = getWebsitePathConfig();
    const configured = Array.isArray(botConfig.knowledge_urls) ? botConfig.knowledge_urls : [];
    const derived = [
        '/',
        paths.about,
        paths.contact,
        paths.services,
        paths.pricing,
        paths.terms,
        paths.privacy,
        paths.returns,
        paths.shipping,
        paths.faq,
        paths.orderTracking
    ];
    return [...new Set(
        configured
            .concat(derived)
            .map((url) => buildBrandAbsoluteUrl(url))
            .filter(Boolean)
    )];
}

function getKnowledgeTopicUrls(query) {
    const text = String(query || '').toLowerCase();
    const paths = getWebsitePathConfig();
    const allUrls = getConfiguredKnowledgeUrls();
    const matchesTopic = (url) => {
        const raw = String(url || '').toLowerCase();
        if (!raw) return false;
        if (/\b(privacy|data\s*privacy|personal\s*data|personal\s*information)\b/.test(text)) {
            return raw.includes(String(paths.privacy).toLowerCase()) || raw.includes('/privacy');
        }
        if (/\b(return|refund|exchange|replacement|replace|cancel|cancellation)\b/.test(text)) {
            return raw.includes(String(paths.returns).toLowerCase()) || raw.includes('/refund') || raw.includes('/return') || raw.includes('/exchange');
        }
        if (/\b(shipping|delivery|dispatch|courier|shipment|tracking|track|order\s*tracking)\b/.test(text)) {
            return raw.includes(String(paths.shipping).toLowerCase()) || raw.includes(String(paths.orderTracking).toLowerCase()) || raw.includes('/shipping') || raw.includes('/tracking');
        }
        if (/\b(contact|support|customer\s*care|email|phone|whatsapp)\b/.test(text)) {
            return raw.includes(String(paths.contact).toLowerCase()) || raw.includes('/contact');
        }
        if (/\b(terms|terms\s+of\s+service|legal|conditions)\b/.test(text)) {
            return raw.includes(String(paths.terms).toLowerCase()) || raw.includes('/terms');
        }
        if (/\b(pricing|price|plan|plans|cost|charges)\b/.test(text)) {
            return raw.includes(String(paths.pricing).toLowerCase());
        }
        if (/\b(feature|features|service|services|benefit|benefits|integration|integrations|multilingual|language|languages|crm|instagram|facebook|website)\b/.test(text)) {
            return raw.includes(String(paths.services).toLowerCase()) || raw.includes('/collections/');
        }
        if (/\b(what\s+is|about|mission|vision|team|who\s+are|company|brand)\b/.test(text)) {
            return raw.includes(String(paths.about).toLowerCase()) || raw.endsWith('/');
        }
        return false;
    };
    const topicUrls = allUrls.filter(matchesTopic);
    return topicUrls.length ? topicUrls : allUrls;
}

function buildAbsoluteUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return `${PRODUCT_BASE_URL}${s}`;
    return `${PRODUCT_BASE_URL}/${s}`;
}

function buildProductUrl(handle) {
    const safe = encodeURIComponent(String(handle || '').trim());
    if (!safe) return '';
    if (!PRODUCT_PATH_TEMPLATE) return '';
    return buildAbsoluteUrl(PRODUCT_PATH_TEMPLATE.replace('{handle}', safe));
}

function normalizeCollections(entries) {
    if (!PRODUCT_DATA_ENABLED) return [];
    const raw = Array.isArray(entries) ? entries : [];
    const list = raw.length ? raw : [];
    return list.map((entry) => {
        const name = entry && entry.name ? String(entry.name) : 'collection';
        const label = entry && entry.label ? String(entry.label) : name;
        const basePath = entry && (entry.path || entry.url) ? String(entry.path || entry.url) : `/collections/${name}`;
        const pageUrl = buildAbsoluteUrl(basePath);
        const productsJsonUrl = entry && entry.productsJsonUrl
            ? buildAbsoluteUrl(entry.productsJsonUrl)
            : buildAbsoluteUrl(basePath.replace(/\/$/, '') + '/products.json');
        return { name, label, pageUrl, productsJsonUrl };
    });
}

function getBotId() {
    return BOT_ID;
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
let knowledgeChunksAvailable = true;

function isMissingKnowledgeTable(error) {
    const msg = error && error.message ? String(error.message) : String(error || "");
    if (!msg) return false;
    return /knowledge_chunks|match_knowledge_chunks|schema cache|relation .*knowledge_chunks|function .*match_knowledge_chunks/i.test(msg);
}

function extractDetail(html, field) {
    if (!html) return "";
    try {
        const regex = new RegExp(`${field}:\\s*([^<\\n]+)`, 'i');
        const match = html.match(regex);
        return match ? match[1].trim() : "";
    } catch (e) {
        return "";
    }
}

function cleanPageText(html) {
    if (!html) return "";
    try {
        const $ = cheerio.load(html);
        $('script, style, nav, footer, header, svg, img, noscript').remove();
        const text = $('body').text();
        return normalizeSpaces(text);
    } catch (e) {
        return normalizeSpaces(html);
    }
}

function splitIntoSentences(text) {
    const t = normalizeSpaces(text);
    if (!t) return [];
    const matches = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    return matches.map(s => s.trim()).filter(Boolean);
}

function chunkText(text, options = {}) {
    const maxChars = Number.isFinite(options.maxChars) ? Math.max(200, Math.floor(options.maxChars)) : 800;
    const minChars = Number.isFinite(options.minChars) ? Math.max(80, Math.floor(options.minChars)) : 220;
    const overlapSentences = Number.isFinite(options.overlapSentences) ? Math.max(0, Math.floor(options.overlapSentences)) : 1;
    const sentences = splitIntoSentences(text);
    if (!sentences.length) return [];
    const chunks = [];
    let current = "";
    for (let i = 0; i < sentences.length; i += 1) {
        const s = sentences[i];
        if (!current) {
            current = s;
            continue;
        }
        if ((current.length + 1 + s.length) <= maxChars) {
            current = `${current} ${s}`.trim();
            continue;
        }
        if (current.trim().length >= minChars || !chunks.length) {
            chunks.push(current.trim());
        }
        const startOverlap = overlapSentences > 0 ? Math.max(0, i - overlapSentences) : i;
        const overlap = overlapSentences > 0 ? sentences.slice(startOverlap, i).join(" ") : "";
        current = overlap ? `${overlap} ${s}`.trim() : s;
    }
    if (current.trim()) {
        chunks.push(current.trim());
    }
    return chunks.filter((c) => c.length >= 60);
}

function inferPageType(url) {
    const raw = String(url || '').toLowerCase();
    if (!raw) return "unknown";
    const paths = getWebsitePathConfig();
    const pathMap = [
        { type: "pricing", keys: [paths.pricing, "/pricing"] },
        { type: "about", keys: [paths.about, "/about"] },
        { type: "contact", keys: [paths.contact, "/contact"] },
        { type: "services", keys: [paths.services, "/services", "/our-services", "/collections/"] },
        { type: "shipping", keys: [paths.shipping, paths.orderTracking, "/shipping", "/tracking"] },
        { type: "returns", keys: [paths.returns, "/return", "/returns", "/refund", "/exchange"] },
        { type: "privacy", keys: [paths.privacy, "/privacy"] },
        { type: "terms", keys: [paths.terms, "/terms"] },
        { type: "faq", keys: [paths.faq, "/faq"] },
        { type: "collection", keys: ["/collections/"] },
        { type: "product", keys: ["/products/"] },
        { type: "cart", keys: ["/cart"] },
        { type: "checkout", keys: ["/checkout"] }
    ];
    for (const entry of pathMap) {
        const keys = Array.isArray(entry.keys) ? entry.keys : [];
        for (const k of keys) {
            if (!k) continue;
            const needle = String(k).toLowerCase();
            if (needle && raw.includes(needle)) return entry.type;
        }
    }
    if (raw.endsWith('/')) return "homepage";
    return "page";
}

async function embedTexts(texts) {
    if (!openai || !OPENAI_API_KEY) return [];
    const inputs = Array.isArray(texts) ? texts.map(t => String(t || '').slice(0, 1200)) : [];
    if (!inputs.length) return [];
    const resp = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: inputs
    });
    const data = Array.isArray(resp && resp.data) ? resp.data : [];
    return data.map(d => d && d.embedding ? d.embedding : null);
}

async function storeKnowledgeChunks({ pageUrl, pageType, chunks }) {
    if (!supabase || !getBotId()) return { inserted: 0 };
    const cleanChunks = Array.isArray(chunks) ? chunks.map(c => String(c || '').trim()).filter(Boolean) : [];
    if (!cleanChunks.length) return { inserted: 0 };
    const batchSize = 48;
    const insertBatchSize = 200;
    let inserted = 0;
    for (let i = 0; i < cleanChunks.length; i += batchSize) {
        const batchTexts = cleanChunks.slice(i, i + batchSize);
        const embeddings = await embedTexts(batchTexts);
        const entries = [];
        for (let j = 0; j < batchTexts.length; j += 1) {
            const embedding = embeddings[j];
            if (!embedding) continue;
            entries.push({
                page_url: pageUrl,
                page_type: pageType,
                chunk_text: batchTexts[j],
                embedding,
                bot_id: getBotId()
            });
        }
        for (let k = 0; k < entries.length; k += insertBatchSize) {
            const chunk = entries.slice(k, k + insertBatchSize);
            const { error } = await supabase.from('knowledge_chunks').insert(chunk);
            if (error) {
                return { inserted, error: error.message || String(error) };
            }
            inserted += chunk.length;
        }
    }
    return { inserted };
}

async function queryKnowledgeChunks(query, options = {}) {
    const q = String(query || '').trim();
    if (!q) return { content: '', matches: [], score: 0, answer: '', normalizedQuery: '' };

    // Also check scraped knowledge
    const scrapedKnowledge = scraper.getKnowledge();
    const qLower = q.toLowerCase();
    const qWords = qLower.split(/\s+/).filter(w => w.length > 2);
    
    const scrapedMatches = scrapedKnowledge
        .map(k => {
            const contentLower = k.content.toLowerCase();
            let score = 0;
            if (contentLower.includes(qLower)) {
                score = 0.9;
            } else if (qWords.length > 0) {
                const overlap = qWords.filter(w => contentLower.includes(w)).length;
                score = overlap / qWords.length * 0.7;
            }
            return { content: k.content.slice(0, 1000), score };
        })
        .filter(m => m.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    if (!supabase || !openai || !getBotId()) {
        const content = scrapedMatches.map(m => m.content).join('\n\n');
        return { content, matches: scrapedMatches, score: scrapedMatches.length ? scrapedMatches[0].score : 0, answer: content, normalizedQuery: q };
    }
    if (!knowledgeChunksAvailable) {
        return { content: '', matches: scrapedMatches, score: scrapedMatches.length ? scrapedMatches[0].score : 0, answer: '', normalizedQuery: q, tableMissing: true };
    }
    const matchCount = Number.isFinite(options.matchCount) && options.matchCount > 0 ? Math.floor(options.matchCount) : 6;
    const matchThreshold = Number.isFinite(options.matchThreshold) ? Number(options.matchThreshold) : 0.78;
    const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 120 ? Math.floor(options.maxChars) : 520;
    const [queryEmbedding] = await embedTexts([q]);
    if (!queryEmbedding) return { content: '', matches: scrapedMatches, score: scrapedMatches.length ? scrapedMatches[0].score : 0, answer: '', normalizedQuery: q };
    const { data, error } = await supabase.rpc('match_knowledge_chunks', {
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
        filter_bot_id: getBotId()
    });
    if (error || !Array.isArray(data)) {
        if (error && isMissingKnowledgeTable(error)) {
            knowledgeChunksAvailable = false;
            return { content: '', matches: scrapedMatches, score: scrapedMatches.length ? scrapedMatches[0].score : 0, answer: '', normalizedQuery: q, tableMissing: true };
        }
        return { content: '', matches: scrapedMatches, score: scrapedMatches.length ? scrapedMatches[0].score : 0, answer: '', normalizedQuery: q };
    }
    let matches = data.map((row) => {
        const text = String(row.chunk_text || '').replace(/\s+/g, ' ').trim();
        const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}` : text;
        return {
            content: clipped,
            page_url: row.page_url || null,
            page_type: row.page_type || null,
            score: typeof row.similarity === 'number' ? row.similarity : null
        };
    }).filter((m) => {
        if (!m.content) return false;
        if (!PRODUCT_DATA_ENABLED) {
            const url = String(m.page_url || '');
            if (/(\/products(?:\.json)?|\/collections\/|\/recommendations\/)/i.test(url)) return false;
        }
        return true;
    });

    if (matches.length === 0 && scrapedMatches.length > 0) {
        matches = scrapedMatches;
    }
    const content = matches.map(m => m.content).join('\n\n');
    const topScore = matches.length && typeof matches[0].score === 'number' ? matches[0].score : 0;
    return { content, matches, score: topScore, answer: content, normalizedQuery: q };
}

function extractRatingFromText(text) {
    if (!text) return null;
    const cleaned = String(text);
    const patterns = [
        /(\d(?:\.\d+)?)[\s·]*Rs\./i,
        /(\d(?:\.\d+)?)[\s·]*\/\s*5/i,
        /(\d(?:\.\d+)?)[\s·]*(?:star|stars)/i,
        /(\d(?:\.\d+)?)[\s·]*[★⭐]/i
    ];
    for (const re of patterns) {
        const m = cleaned.match(re);
        if (m) {
            const num = parseFloat(String(m[1]).replace(',', '.'));
            if (!Number.isNaN(num) && num >= 0 && num <= 5) {
                return num;
            }
        }
    }
    const rsIndex = cleaned.toLowerCase().indexOf('rs.');
    if (rsIndex > 0) {
        const before = cleaned.slice(0, rsIndex);
        const nums = before.match(/(\d+(?:\.\d+)?)/g);
        if (nums && nums.length) {
            const candidate = parseFloat(nums[nums.length - 1].replace(',', '.'));
            if (!Number.isNaN(candidate) && candidate >= 0 && candidate <= 5) {
                return candidate;
            }
        }
    }
    return null;
}

function extractPriceFromText(text) {
    const t = normalizeSpaces(text);
    if (!t) return '';
    const pickNumber = (startIndex) => {
        let num = '';
        for (let i = startIndex; i < t.length; i += 1) {
            const ch = t[i];
            const isNum = ch >= '0' && ch <= '9';
            if (isNum || ch === ',' || ch === '.') {
                num += ch;
            } else if (num) {
                break;
            }
        }
        return num;
    };
    const rupeeIndex = t.indexOf('₹');
    if (rupeeIndex >= 0) {
        const num = pickNumber(rupeeIndex + 1);
        if (num) return `₹${num}`;
    }
    const rsIndex = t.indexOf('Rs');
    if (rsIndex >= 0) {
        let i = rsIndex + 2;
        while (t[i] === '.' || t[i] === ' ') i += 1;
        const num = pickNumber(i);
        if (num) return `Rs ${num}`;
    }
    const inrIndex = t.indexOf('INR');
    if (inrIndex >= 0) {
        let i = inrIndex + 3;
        while (t[i] === '.' || t[i] === ' ') i += 1;
        const num = pickNumber(i);
        if (num) return `INR ${num}`;
    }
    return '';
}

function extractBillingPeriod(text) {
    const lc = normalizeSpaces(text).toLowerCase();
    if (lc.includes('month')) return '/Month';
    if (lc.includes('year')) return '/Year';
    if (lc.includes('week')) return '/Week';
    return '';
}

// yeh in‑memory cache Anhance products ko store karta hai taa ki baar‑baar Shopify hit na ho
let productCache = {
    data: [],
    lastFetched: null,
    incomplete: false
};

let productCodeIndex = {
    all: new Set(),
    live: new Set()
};

let productCodeDetails = new Map();

const CACHE_DURATION_MINUTES = 1440;

let productFetchInFlight = null;

const SERVICE_CARDS_TTL_MS = 30 * 60 * 1000;
let serviceCardsCache = {
    data: [],
    lastFetched: 0
};
const PRICING_CARDS_TTL_MS = 30 * 60 * 1000;
let pricingCardsCache = {
    data: [],
    lastFetched: 0
};
const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 8000;
const PRODUCT_BOOTSTRAP_BUDGET_MS = Number(process.env.PRODUCT_BOOTSTRAP_BUDGET_MS) || 12000;
const RATINGS_SCRAPE_BUDGET_MS = Number(process.env.RATINGS_SCRAPE_BUDGET_MS) || 2500;
const MAX_PRODUCT_PAGES = Number(process.env.MAX_PRODUCT_PAGES) || 25;

// yeh helper batata hai ki abhi cache me kaunse products hain aur last refresh kab hua
function getProductCacheInfo() {
    return {
        data: Array.isArray(productCache.data) ? productCache.data : [],
        lastFetched: productCache.lastFetched,
        incomplete: !!productCache.incomplete
    };
}

function timeoutAfter(ms, label) {
    const waitMs = Number.isFinite(ms) && ms > 0 ? ms : 8000;
    const name = label ? String(label) : `timeout after ${waitMs}ms`;
    return new Promise((_, reject) => setTimeout(() => reject(new Error(name)), waitMs));
}

// yeh wrapper axios GET ko hard timeout ke saath run karta hai (stuck requests ko kill karne ke liye)
async function axiosGetWithHardTimeout(url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
    const opts = {
        timeout: ms,
        validateStatus: (status) => status >= 200 && status < 400,
        ...DIRECT_HTTP_OPTIONS,
        ...(options && typeof options === 'object' ? options : {})
    };
    if (!opts.headers) opts.headers = {};
    if (!opts.headers['User-Agent'] && !opts.headers['user-agent']) {
        opts.headers['User-Agent'] = USER_AGENT;
    }
    return Promise.race([
        axios.get(url, opts),
        timeoutAfter(ms + 500, `HTTP timeout: ${url}`)
    ]);
}

const productPageExtrasCache = new Map();
const PRODUCT_PAGE_EXTRAS_TTL_MS = 6 * 60 * 60 * 1000;
const PRODUCT_PAGE_EXTRAS_CONCURRENCY = 4;

function extractHandleFromProductLink(link) {
    const m = String(link || '').match(/\/products\/([^\/\?#]+)/i);
    return m ? m[1] : null;
}

function cleanInlineText(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/:\s+/g, ': ')
        .trim();
}

function parseRatingAndReviewCountFromText(text) {
    const t = cleanInlineText(text);
    if (!t) return { rating: null, reviewCount: null };
    const m1 = t.match(/(\d(?:\.\d)?)\s*(?:\/\s*5)?\s*\(\s*(\d+)\s*reviews?\s*\)/i);
    if (m1) {
        const rating = Number(m1[1]);
        const reviewCount = Number(m1[2]);
        return {
            rating: Number.isFinite(rating) ? rating : null,
            reviewCount: Number.isFinite(reviewCount) ? reviewCount : null
        };
    }
    const m2 = t.match(/(\d+)\s*reviews?\b/i);
    const reviewCount = m2 ? Number(m2[1]) : null;
    return { rating: null, reviewCount: Number.isFinite(reviewCount) ? reviewCount : null };
}

function parsePromotionsFromText(text) {
    const t = cleanInlineText(text);
    if (!t) return [];
    const promos = [];

    const normalizePromo = (s) => {
        let x = cleanInlineText(s);
        x = x
            .replace(/\bCopied!\b/ig, '')
            .replace(/\bAdd to cart\b/ig, '')
            .replace(/\bBuy Now\b/ig, '')
            .replace(/\bCheckout\b/ig, '')
            .replace(/\bAvailable At Checkout\b/ig, '')
            .replace(/\bSize Chart\b/ig, '')
            .replace(/\bFree Shipping\b/ig, '')
            .replace(/\bEasy Size Exchange\b/ig, '')
            .replace(/\bCOD\b/ig, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (x.length > 90) {
            x = x.slice(0, 90).replace(/\s+\S*$/, '').trim();
        }
        return x;
    };

    const codes = [];
    const codeRegex = /use\s*code\s*[:\s]*([A-Z0-9][A-Z0-9_-]{2,20})/ig;
    let m;
    while ((m = codeRegex.exec(t)) !== null) {
        const code = m[1];
        if (code && !codes.includes(code)) {
            codes.push(code);
        }
    }
    for (const code of codes) {
        promos.push(`Use code ${code}`);
    }

    const patterns = [
        /\bfestive\s+offer\b[^.]{0,120}/ig,
        /\bflat\s+\d{1,2}%\s*off\b[^.]{0,120}/ig,
        /\b(?:upto|up to)\s+\d{1,2}%\s*off\b[^.]{0,120}/ig,
        /\bextra\s+\d{1,2}%\s*off\b[^.]{0,120}/ig,
        /\bextra\s+\d{1,2}%\s*off\b[^.]{0,120}\bprepaid\b[^.]{0,80}/ig,
        /\bprepaid\b[^.]{0,120}\b\d{1,2}%\s*off\b[^.]{0,120}/ig
    ];
    while ((m = patterns[0].exec(t)) !== null) {}
    for (const re of patterns) {
        let match;
        while ((match = re.exec(t)) !== null) {
            const snippet = normalizePromo(match[0]);
            if (snippet) promos.push(snippet);
        }
    }

    const dedup = [];
    const seen = new Set();
    for (const p of promos) {
        const key = p.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        dedup.push(p);
    }
    return dedup.slice(0, 3);
}

function extractAggregateRatingFromHtml(html) {
    const raw = String(html || '');
    if (!raw) return { rating: null, reviewCount: null };

    const toNumberOrNull = (v) => {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
    };

    const pickFromAggregateRating = (ar) => {
        if (!ar || typeof ar !== 'object') return { rating: null, reviewCount: null };
        const rating = toNumberOrNull(ar.ratingValue);
        const reviewCount = toNumberOrNull(ar.reviewCount != null ? ar.reviewCount : ar.ratingCount);
        return { rating, reviewCount };
    };

    const findAggregateRating = (node, depth = 0) => {
        if (!node || depth > 10) return null;
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = findAggregateRating(item, depth + 1);
                if (found) return found;
            }
            return null;
        }
        if (typeof node !== 'object') return null;
        if (node.aggregateRating) {
            const picked = pickFromAggregateRating(node.aggregateRating);
            if (picked.rating != null || picked.reviewCount != null) return picked;
        }
        for (const key of Object.keys(node)) {
            const found = findAggregateRating(node[key], depth + 1);
            if (found) return found;
        }
        return null;
    };

    try {
        const $ = cheerio.load(raw || '');
        const ldJson = $('script[type="application/ld+json"]').toArray();
        for (const el of ldJson) {
            const text = $(el).contents().text();
            const trimmed = String(text || '').trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                const found = findAggregateRating(parsed);
                if (found) return found;
            } catch (e) {}
        }
    } catch (e) {}

    const normalized = raw.replace(/\\"/g, '"');
    const blockRe = /["']?aggregateRating["']?\s*:\s*\{[\s\S]*?\}/ig;
    const blocks = Array.from(normalized.matchAll(blockRe)).map((x) => x[0]).filter(Boolean);
    for (const block of blocks) {
        const ratingMatch = block.match(/["']?ratingValue["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?/i);
        const countMatch = block.match(/["']?(?:ratingCount|reviewCount)["']?\s*:\s*["']?(\d+)["']?/i);
        const rating = ratingMatch ? toNumberOrNull(ratingMatch[1]) : null;
        const reviewCount = countMatch ? toNumberOrNull(countMatch[1]) : null;
        if (rating != null || reviewCount != null) return { rating, reviewCount };
    }

    return { rating: null, reviewCount: null };
}

function parseProductPageExtras(html) {
    const agg = extractAggregateRatingFromHtml(html);
    const $ = cheerio.load(html || '');
    $('script, style, svg').remove();
    const bodyText = cleanInlineText($('body').text());
    const ratingInfo = parseRatingAndReviewCountFromText(bodyText);
    const promos = parsePromotionsFromText(bodyText);

    const extractSection = (text, label, nextLabels) => {
        if (!text || !label) return null;
        const t = String(text);
        const startIdx = t.indexOf(label);
        if (startIdx === -1) return null;
        const from = startIdx + label.length;
        let end = t.length;
        if (Array.isArray(nextLabels)) {
            for (const nl of nextLabels) {
                if (!nl) continue;
                const idx = t.indexOf(nl, from);
                if (idx !== -1 && idx < end) {
                    end = idx;
                }
            }
        }
        const slice = t.slice(from, end).trim();
        return slice || null;
    };

    const descriptionSection = extractSection(bodyText, 'DESCRIPTION', ['DETAILS', 'MANUFACTURING', 'Customer Reviews']);
    const detailsSection = extractSection(bodyText, 'DETAILS', ['MANUFACTURING', 'Customer Reviews']);
    const manufacturingSection = extractSection(bodyText, 'MANUFACTURING', ['Customer Reviews']);
    const reviewsSection = extractSection(bodyText, 'Customer Reviews', []);

    const shippingBadges = [];
    if (/Free Shipping on orders? over/i.test(bodyText)) shippingBadges.push('Free Shipping on qualifying orders');
    if (/Easy Size Exchange/i.test(bodyText)) shippingBadges.push('Easy Size Exchange available');
    if (/COD available/i.test(bodyText)) shippingBadges.push('Cash on Delivery available');
    if (/Safe and Secure Payments/i.test(bodyText)) shippingBadges.push('Safe and Secure Payments');

    return {
        rating: agg.rating != null ? agg.rating : ratingInfo.rating,
        reviewCount: agg.reviewCount != null ? agg.reviewCount : ratingInfo.reviewCount,
        promotions: promos,
        descriptionSection,
        detailsSection,
        manufacturingSection,
        reviewsSection,
        shippingBadges
    };
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = new Array(Math.max(1, limit)).fill(null).map(async () => {
        while (idx < items.length) {
            const cur = idx++;
            results[cur] = await fn(items[cur], cur);
        }
    });
    await Promise.all(workers);
    return results;
}

async function fetchProductPageExtras(handle) {
    const h = String(handle || '').trim();
    if (!h) return null;
    const cached = productPageExtrasCache.get(h);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.data;
    try {
        const url = buildProductUrl(h);
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 8000,
            ...DIRECT_HTTP_OPTIONS
        });
        const parsed = parseProductPageExtras(html);
        productPageExtrasCache.set(h, { data: parsed, expiresAt: now + PRODUCT_PAGE_EXTRAS_TTL_MS });
        return parsed;
    } catch (e) {
        productPageExtrasCache.set(h, { data: null, expiresAt: now + 30 * 60 * 1000 });
        return null;
    }
}

// yeh function product list me jaa kar unki product page se rating, reviews, promos wagairah inject karta hai
async function enrichProductsWithPageExtras(products) {
    const list = Array.isArray(products) ? products : [];
    if (!list.length) return;
    const handles = [];
    const byHandle = new Map();
    for (const p of list) {
        const handle = extractHandleFromProductLink(p && p.link);
        if (!handle) continue;
        if (!byHandle.has(handle)) {
            byHandle.set(handle, []);
            handles.push(handle);
        }
        byHandle.get(handle).push(p);
    }
    if (!handles.length) return;
    await mapWithConcurrency(handles, PRODUCT_PAGE_EXTRAS_CONCURRENCY, async (handle) => {
        const extras = await fetchProductPageExtras(handle);
        if (!extras) return;
        const targets = byHandle.get(handle) || [];
        for (const p of targets) {
            if (extras.reviewCount != null) p.reviewCount = extras.reviewCount;
            if (Array.isArray(extras.promotions) && extras.promotions.length) p.promotions = extras.promotions;
            if (extras.rating != null && (p.rating == null || !Number.isFinite(p.rating))) p.rating = extras.rating;
            if (extras.descriptionSection && !p.description) p.description = extras.descriptionSection;
            if (extras.detailsSection && !p.detailsText) p.detailsText = extras.detailsSection;
            if (extras.manufacturingSection && !p.manufacturingInfo) p.manufacturingInfo = extras.manufacturingSection;
            if (extras.reviewsSection && !p.reviewsText) p.reviewsText = extras.reviewsSection;
            if (Array.isArray(extras.shippingBadges) && extras.shippingBadges.length && !p.shippingBadges) p.shippingBadges = extras.shippingBadges;
        }
    });
}

// yeh function code se check karta hai ki product live hai, out of stock hai ya unknown
function getProductCodeStatus(code) {
    const c = String(code || '').trim();
    if (!c) return 'unknown';
    if (productCodeIndex.live.has(c)) return 'available';
    if (productCodeIndex.all.has(c)) return 'out_of_stock';
    return 'not_found';
}

function getProductDetailsByCode(code) {
    const c = String(code || '').trim();
    if (!c) return null;
    const snapshot = productCodeDetails.get(c) || null;
    if (!snapshot) return null;
    return { ...snapshot };
}

const scraper = require('./services/scraper');

// yeh main Shopify se live products laata hai, cache fill karta hai aur codes index banata hai
async function getLiveProducts() {
    const scrapedProducts = scraper.getProducts();
    
    // Filter scraped products: must have a price and shouldn't have noise titles
    const validScraped = scrapedProducts.filter(p => {
        if (!p.title || !p.price) return false;
        const titleLower = p.title.toLowerCase();
        const noise = ['filter', 'sort by', 'cart', 'navigation', 'menu', 'checkout', 'item added to your cart'];
        return !noise.some(k => titleLower.includes(k));
    });

    if (validScraped.length > 0) {
        return validScraped.map(p => ({
            ...p,
            name: p.title,
            numericPrice: parseFloat(String(p.price).replace(/[^0-9.]/g, '')) || 0,
            imageUrl: p.image || 'https://placehold.co/400x400/eee/ccc?text=No+Image',
            images: Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []),
            category: p.productType || p.category || 'Product',
            tags: Array.isArray(p.tags) && p.tags.length ? p.tags : (p.features || []),
            skus: [],
            codes: [String(p.id)],
            colors: Array.isArray(p.colors) ? p.colors : [],
            sizes: Array.isArray(p.sizes) ? p.sizes : [],
            compareAtPrice: p.compareAtPrice || null,
            originalPrice: p.originalPrice || p.compareAtPrice || null,
            onSale: !!p.onSale,
            isOnSale: !!(p.isOnSale || p.onSale),
            vendor: p.vendor || 'Nutrabay',
            rating: typeof p.rating === 'number' ? p.rating : null,
            reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : null,
            promotions: Array.isArray(p.promotions) ? p.promotions : [],
            shippingBadges: Array.isArray(p.shippingBadges) ? p.shippingBadges : []
        }));
    }

    if (!PRODUCT_DATA_ENABLED || !PRODUCTS_JSON_PATH) {
        return [];
    }
    const now = new Date();
    const ttlMinutes = productCache && productCache.incomplete ? 5 : CACHE_DURATION_MINUTES;
    if (productCache.lastFetched && (now - productCache.lastFetched) < (ttlMinutes * 60 * 1000)) {
        return productCache.data;
    }
    if (productFetchInFlight) {
        return productFetchInFlight;
    }

    productFetchInFlight = (async () => {
        const startedAt = Date.now();
        const budgetExceeded = () => (Date.now() - startedAt) > PRODUCT_BOOTSTRAP_BUDGET_MS;
        let incomplete = false;

        productCodeIndex = {
            all: new Set(),
            live: new Set()
        };
        productCodeDetails = new Map();

        const collections = normalizeCollections(PRODUCT_DATA.collections);

        const allProducts = new Map();

        const ratingsByHandle = new Map();
        const ratingsStart = Date.now();
        const ratingCollections = [...collections, { name: 'all' }];
        for (const entry of ratingCollections) {
            if (budgetExceeded() || (Date.now() - ratingsStart) > RATINGS_SCRAPE_BUDGET_MS) {
                incomplete = true;
                break;
            }
                const collectionPageUrl = entry.pageUrl || buildAbsoluteUrl(`/collections/${entry.name}`);
            try {
                const { data: html } = await axiosGetWithHardTimeout(collectionPageUrl, {}, 8000);
                const $ = cheerio.load(html);
                $('a[href*="/products/"]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    const match = href.match(/\/products\/([^\/\?#]+)/i);
                    if (!match) return;
                    const handle = match[1];
                    let container = $(el).closest('article, .grid__item, .product-item, .card, li');
                    if (!container.length) {
                        container = $(el).parent();
                    }
                    const text = container.text().replace(/\s+/g, ' ').trim();
                    if (!text) return;
                    const rating = extractRatingFromText(text);
                    if (rating == null) return;
                    const existing = ratingsByHandle.get(handle);
                    if (!existing || rating > existing) {
                        ratingsByHandle.set(handle, rating);
                    }
                });
            } catch (e) {
                incomplete = true;
            }
        }

        try {
            let page = 1;
            let hasMore = true;
            while (hasMore) {
                if (budgetExceeded()) {
                    incomplete = true;
                    break;
                }
                if (page > MAX_PRODUCT_PAGES) {
                    incomplete = true;
                    break;
                }
                const productsJsonUrl = buildAbsoluteUrl(PRODUCTS_JSON_PATH);
                const productApiUrl = `${productsJsonUrl}${productsJsonUrl.includes('?') ? '&' : '?'}limit=250&page=${page}`;
                const { data } = await axiosGetWithHardTimeout(productApiUrl, {}, 8000);
                if (data.products && data.products.length > 0) {
                    data.products.forEach((product) => {
                        const variantSkus = Array.isArray(product.variants) ? product.variants.map((v) => v.sku).filter(Boolean) : [];
                        const titleCodes = product.title ? (product.title.match(/\b\d{3,6}\b/g) || []) : [];
                        const skuCodes = variantSkus.flatMap((s) => String(s).match(/\b\d{3,6}\b/g) || []);
                        const codes = Array.from(new Set([...titleCodes, ...skuCodes]));
                        codes.forEach((code) => productCodeIndex.all.add(String(code)));
                        if (codes.length) {
                            const snapshot = {
                                id: `prod_${product.id}`,
                                shopifyId: product.id,
                                name: product.title,
                                link: buildProductUrl(product.handle),
                                description: product.body_html ? product.body_html.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim() : ''
                            };
                            codes.forEach((code) => {
                                const key = String(code);
                                if (!productCodeDetails.has(key)) {
                                    productCodeDetails.set(key, snapshot);
                                }
                            });
                        }
                        const isAvailable = product.variants.some((variant) => variant.available);
                        if (isAvailable && !allProducts.has(product.id)) {
                            codes.forEach((code) => productCodeIndex.live.add(String(code)));
                            const availableVariants = Array.isArray(product.variants)
                                ? product.variants.filter((v) => v.available)
                                : [];
                            const firstVariant = availableVariants[0] || product.variants[0];
                            const price = parseFloat(firstVariant.price);
                            const compareAtPrice = firstVariant.compare_at_price ? parseFloat(firstVariant.compare_at_price) : null;
                            const isOnSale = compareAtPrice && compareAtPrice > price;
                            const optionNames = Array.isArray(product.options) ? product.options.map((o) => (typeof o === 'string' ? o : (o && o.name) ? o.name : '')) : [];
                            const opt1Name = String(optionNames[0] || '').toLowerCase();
                            const opt2Name = String(optionNames[1] || '').toLowerCase();
                            const values1 = Array.isArray(product.variants) ? product.variants.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim()) : [];
                            const values2 = Array.isArray(product.variants) ? product.variants.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim()) : [];
                            const dedup = (arr) => {
                                const m = new Map();
                                arr.forEach((val) => {
                                    const key = String(val).toLowerCase();
                                    if (!m.has(key)) m.set(key, val);
                                });
                                return Array.from(m.values());
                            };
                            const isNumericVal = (val) => /^\d+(\.\d+)?$/.test(String(val).trim()) || /^(xxs|xs|s|m|l|xl|xxl|3xl|4xl)$/i.test(String(val).trim());
                            const mostlyNumeric = (arr) => {
                                const a = dedup(arr);
                                if (!a.length) return false;
                                const count = a.filter((v) => isNumericVal(v)).length;
                                return count >= Math.ceil(a.length * 0.6);
                            };
                            let sizeValues = [];
                            let colorValues = [];
                            const available = availableVariants.length ? availableVariants : Array.isArray(product.variants) ? product.variants : [];
                            if (opt1Name.includes('size')) {
                                sizeValues = available.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues = available.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            } else if (opt2Name.includes('size')) {
                                sizeValues = available.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                                colorValues = available.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                            } else if (mostlyNumeric(values1)) {
                                sizeValues = available.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues = available.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            } else if (mostlyNumeric(values2)) {
                                sizeValues = available.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                                colorValues = available.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                            } else {
                                sizeValues = available.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues = available.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            }
                            sizeValues = dedup(sizeValues);
                            colorValues = dedup(colorValues);
                            const rating = ratingsByHandle.get(product.handle) || null;
                            const built = {
                                id: `live_prod_${product.id}`,
                                shopifyId: product.id,
                                name: product.title,
                                price: `Rs. ${price.toFixed(2)}`,
                                numericPrice: price,
                                originalPrice: isOnSale ? `Rs. ${compareAtPrice.toFixed(2)}` : null,
                                isOnSale,
                                category: product.product_type,
                                tags: product.tags || [],
                                link: buildProductUrl(product.handle),
                                imageUrl: product.images.length > 0 ? product.images[0].src : 'https://placehold.co/400x400/eee/ccc?text=No+Image',
                                skus: variantSkus,
                                codes,
                                colors: colorValues,
                                sizes: sizeValues.map((n) => ({ name: n })),
                                rating,
                                material: extractDetail(product.body_html, 'Material'),
                                fit: extractDetail(product.body_html, 'Fit'),
                                design: extractDetail(product.body_html, 'Design'),
                                durability: extractDetail(product.body_html, 'Durability'),
                                comfort: extractDetail(product.body_html, 'Comfort'),
                                care: extractDetail(product.body_html, 'Care Instructions'),
                                description: product.body_html ? product.body_html.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim() : ''
                            };
                            allProducts.set(product.id, built);
                        }
                    });
                    page++;
                } else {
                    hasMore = false;
                }
            }
        } catch (error) {
            incomplete = true;
        }

        for (const collection of collections) {
            if (budgetExceeded()) {
                incomplete = true;
                break;
            }
            try {
                const { data } = await axiosGetWithHardTimeout(collection.productsJsonUrl, {}, 8000);
                if (data.products && data.products.length > 0) {
                    data.products.forEach((product) => {
                        const variantSkus = Array.isArray(product.variants) ? product.variants.map((v) => v.sku).filter(Boolean) : [];
                        const titleCodes = product.title ? (product.title.match(/\b\d{3,6}\b/g) || []) : [];
                        const skuCodes = variantSkus.flatMap((s) => String(s).match(/\b\d{3,6}\b/g) || []);
                        const codes = Array.from(new Set([...titleCodes, ...skuCodes]));
                        codes.forEach((code) => productCodeIndex.all.add(String(code)));
                        if (codes.length) {
                            const snapshot2 = {
                                id: `prod_${product.id}`,
                                shopifyId: product.id,
                                name: product.title,
                                link: buildProductUrl(product.handle),
                                description: product.body_html ? product.body_html.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim() : ''
                            };
                            codes.forEach((code) => {
                                const key = String(code);
                                if (!productCodeDetails.has(key)) {
                                    productCodeDetails.set(key, snapshot2);
                                }
                            });
                        }
                        const isAvailable = product.variants.some((variant) => variant.available);
                        if (isAvailable) {
                            codes.forEach((code) => productCodeIndex.live.add(String(code)));
                            const availableVariants = Array.isArray(product.variants)
                                ? product.variants.filter((v) => v.available)
                                : [];
                            const firstVariant = availableVariants[0] || product.variants[0];
                            const price = parseFloat(firstVariant.price);
                            const compareAtPrice = firstVariant.compare_at_price ? parseFloat(firstVariant.compare_at_price) : null;
                            const isOnSale = compareAtPrice && compareAtPrice > price;
                            const tags = Array.isArray(product.tags) ? product.tags.slice() : [];
                            if (!tags.includes(collection.name)) tags.push(collection.name);
                            if (collection.label && !tags.includes(collection.label)) tags.push(collection.label);
                            const optionNames2 = Array.isArray(product.options) ? product.options.map((o) => (typeof o === 'string' ? o : (o && o.name) ? o.name : '')) : [];
                            const opt1Name2 = String(optionNames2[0] || '').toLowerCase();
                            const opt2Name2 = String(optionNames2[1] || '').toLowerCase();
                            const values1b = Array.isArray(product.variants) ? product.variants.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim()) : [];
                            const values2b = Array.isArray(product.variants) ? product.variants.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim()) : [];
                            const dedup2 = (arr) => {
                                const m = new Map();
                                arr.forEach((val) => {
                                    const key = String(val).toLowerCase();
                                    if (!m.has(key)) m.set(key, val);
                                });
                                return Array.from(m.values());
                            };
                            const isNumericVal2 = (val) => /^\d+(\.\d+)?$/.test(String(val).trim()) || /^(xxs|xs|s|m|l|xl|xxl|3xl|4xl)$/i.test(String(val).trim());
                            const mostlyNumeric2 = (arr) => {
                                const a = dedup2(arr);
                                if (!a.length) return false;
                                const count = a.filter((v) => isNumericVal2(v)).length;
                                return count >= Math.ceil(a.length * 0.6);
                            };
                            let sizeValues2 = [];
                            let colorValues2 = [];
                            const available2 = availableVariants.length ? availableVariants : Array.isArray(product.variants) ? product.variants : [];
                            if (opt1Name2.includes('size')) {
                                sizeValues2 = available2.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues2 = available2.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            } else if (opt2Name2.includes('size')) {
                                sizeValues2 = available2.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                                colorValues2 = available2.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                            } else if (mostlyNumeric2(values1b)) {
                                sizeValues2 = available2.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues2 = available2.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            } else if (mostlyNumeric2(values2b)) {
                                sizeValues2 = available2.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                                colorValues2 = available2.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                            } else {
                                sizeValues2 = available2.map((v) => v.option1).filter(Boolean).map((s) => String(s).trim());
                                colorValues2 = available2.map((v) => v.option2).filter(Boolean).map((s) => String(s).trim());
                            }
                            sizeValues2 = dedup2(sizeValues2);
                            colorValues2 = dedup2(colorValues2);
                            const rating2 = ratingsByHandle.get(product.handle) || null;
                            const built2 = {
                                id: `live_prod_${product.id}`,
                                shopifyId: product.id,
                                name: product.title,
                                price: `Rs. ${price.toFixed(2)}`,
                                numericPrice: price,
                                originalPrice: isOnSale ? `Rs. ${compareAtPrice.toFixed(2)}` : null,
                                isOnSale,
                                category: product.product_type,
                                tags,
                                link: buildProductUrl(product.handle),
                                images: product.images.map((img) => img.src),
                                imageUrl: product.images.length > 0 ? product.images[0].src : 'https://placehold.co/400x400/eee/ccc?text=No+Image',
                                sizes: sizeValues2.map((n) => ({ name: n })),
                                colors: colorValues2,
                                material: extractDetail(product.body_html, 'Material'),
                                fit: extractDetail(product.body_html, 'Fit'),
                                design: extractDetail(product.body_html, 'Design'),
                                durability: extractDetail(product.body_html, 'Durability'),
                                comfort: extractDetail(product.body_html, 'Comfort'),
                                care: extractDetail(product.body_html, 'Care Instructions'),
                                description: product.body_html ? product.body_html.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim() : '',
                                sizeChart: '',
                                crossSell: product.tags ? product.tags.filter((tag) => tag !== collection.name) : [],
                                skus: variantSkus,
                                codes,
                                collections: collection.label ? [collection.label] : [collection.name],
                                rating: rating2
                            };
                            allProducts.set(product.id, built2);
                        }
                    });
                }
            } catch (error) {
                incomplete = true;
            }
        }

        const liveProducts = Array.from(allProducts.values());
        if (!liveProducts.length && productCache && Array.isArray(productCache.data) && productCache.data.length) {
            return productCache.data;
        }
        productCache = { data: liveProducts, lastFetched: new Date(), incomplete: !!incomplete };
        return liveProducts;
    })().finally(() => {
        productFetchInFlight = null;
    });

    return productFetchInFlight;
}

// yeh Shopify recommendations API se similar products laata hai aur unko hamare live catalog se map karta hai
async function getRecommendedProductsForProduct(baseProduct, limit = 8) {
    try {
        if (PRODUCT_DATA_ENABLED && RECOMMENDATIONS_PATH && baseProduct && baseProduct.shopifyId) {
            const recBase = buildAbsoluteUrl(RECOMMENDATIONS_PATH);
            const url = `${recBase}${recBase.includes('?') ? '&' : '?'}product_id=${baseProduct.shopifyId}&limit=${limit}`;
            const { data } = await axiosGetWithHardTimeout(url, {}, 8000);
            if (data && Array.isArray(data.products) && data.products.length) {
                const all = await getLiveProducts();
                const byShopifyId = new Map(all.map((p) => [String(p.shopifyId), p]));
                const recs = data.products.map((prod) => byShopifyId.get(String(prod.id))).filter(Boolean);
                if (recs.length) return recs;
            }
        }

        const all = await getLiveProducts();
        if (!baseProduct || !Array.isArray(all) || !all.length) {
            return [];
        }
        const baseId = String(baseProduct.id || baseProduct.shopifyId || '');
        const baseTags = new Set(
            []
                .concat(Array.isArray(baseProduct.tags) ? baseProduct.tags : [])
                .concat(baseProduct.category ? [baseProduct.category] : [])
                .concat(baseProduct.vendor ? [baseProduct.vendor] : [])
                .map((tag) => String(tag).toLowerCase())
                .filter(Boolean)
        );

        return all
            .filter((product) => String(product.id || product.shopifyId || '') !== baseId)
            .map((product) => {
                let score = 0;
                const tokens = []
                    .concat(Array.isArray(product.tags) ? product.tags : [])
                    .concat(product.category ? [product.category] : [])
                    .concat(product.vendor ? [product.vendor] : [])
                    .map((tag) => String(tag).toLowerCase())
                    .filter(Boolean);
                tokens.forEach((tag) => {
                    if (baseTags.has(tag)) score += 1;
                });
                if (product.vendor && baseProduct.vendor && String(product.vendor).toLowerCase() === String(baseProduct.vendor).toLowerCase()) score += 2;
                if (product.category && baseProduct.category && String(product.category).toLowerCase() === String(baseProduct.category).toLowerCase()) score += 2;
                return { product, score };
            })
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((entry) => entry.product);
    } catch (e) {
        return [];
    }
}

let knowledgeData = [];

let contactInfoCache = {
    lastFetched: 0,
    phones: [],
    whatsapps: [],
    displayText: ''
};

const CONTACT_INFO_TTL_MS = 6 * 60 * 60 * 1000;

// yeh function Anhance website se phone/WhatsApp contact info scrape karke cache me store karta hai
async function fetchContactInfoFromWebsite() {
    const now = Date.now();
    if (contactInfoCache.lastFetched && (now - contactInfoCache.lastFetched) < CONTACT_INFO_TTL_MS && contactInfoCache.displayText) {
        return contactInfoCache;
    }
    const baseUrl = BRAND_WEBSITE;
    const paths = WEBSITE_PATHS;
    const urls = [
        `${baseUrl}${paths.contact || '/contact-us/'}`,
        `${baseUrl}${paths.about || '/about-us/'}`
    ];
    const phones = [];
    const whatsapps = [];
    const seen = new Set();
    for (const url of urls) {
        try {
            const { data: html } = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': BRAND_WEBSITE
                },
                timeout: 7000,
                ...DIRECT_HTTP_OPTIONS
            });
            const $ = cheerio.load(html);
            $('a[href]').each((_, el) => {
                const href = String($(el).attr('href') || '').trim();
                if (!href) return;
                if (/^tel:/i.test(href)) {
                    const raw = href.replace(/^tel:/i, '').trim();
                    const digitsOnly = raw.replace(/\D/g, '');
                    if (digitsOnly.length >= 10 && digitsOnly.length <= 13 && !seen.has(digitsOnly)) {
                        seen.add(digitsOnly);
                        phones.push(raw);
                    }
                }
                if (/wa\.me|whatsapp/i.test(href)) {
                    const digitsOnly = href.replace(/\D/g, '');
                    if (digitsOnly.length >= 10 && digitsOnly.length <= 13 && !seen.has(digitsOnly)) {
                        seen.add(digitsOnly);
                        whatsapps.push(`+${digitsOnly}`);
                    }
                }
            });
            $('script, style, nav, footer, header, svg, img').remove();
            const text = $('body').text().replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const phoneRegex = /\b(\+?\d[\d\s().-]{8,}\d)\b/g;
            let m;
            while ((m = phoneRegex.exec(text)) !== null) {
                const num = String(m[1] || '').trim();
                if (!num) continue;
                const digitsOnly = num.replace(/\D/g, '');
                if (!digitsOnly || digitsOnly.length < 10 || digitsOnly.length > 13) continue;
                if (seen.has(digitsOnly)) continue;
                seen.add(digitsOnly);
                const normalized = num.replace(/\s+/g, ' ').trim();
                const windowSize = 80;
                const idx = text.indexOf(num);
                const start = Math.max(0, idx - windowSize);
                const end = Math.min(text.length, idx + num.length + windowSize);
                const windowText = text.slice(start, end).toLowerCase();
                const isWhatsapp = /whatsapp|wa\s*ap|wa\s*number/.test(windowText);
                if (isWhatsapp) {
                    whatsapps.push(normalized);
                } else {
                    phones.push(normalized);
                }
            }
        } catch (e) {}
    }
    const uniqueWhatsapps = Array.from(new Set(whatsapps));
    const uniquePhones = Array.from(new Set(phones));
    const lines = [];
    if (uniqueWhatsapps.length) {
        lines.push(`WhatsApp: ${uniqueWhatsapps.join(', ')} (Note: This is the same as our contact number)`);
    }
    if (uniquePhones.length) {
        lines.push(`Phone: ${uniquePhones.join(', ')}`);
    }
    const displayText = lines.join('\n');
    contactInfoCache = {
        lastFetched: Date.now(),
        phones: uniquePhones,
        whatsapps: uniqueWhatsapps,
        displayText
    };
    return contactInfoCache;
}

// yeh function Supabase table se website_knowledge rows read karta hai aur memory me knowledgeData set karta hai
async function loadKnowledgeData() {
    try {
        if (!supabase || !getBotId()) {
            knowledgeData = [];
            return;
        }
        const { data, error } = await supabase
            .from('website_knowledge')
            .select('content')
            .eq('bot_id', getBotId())
            .order('id', { ascending: true });
        if (error) {
            knowledgeData = [];
            return;
        }
        knowledgeData = Array.isArray(data) ? data.map((row) => row.content).filter(Boolean) : [];
    } catch (e) {
        knowledgeData = [];
    }
}

// yeh offline knowledge base (Supabase se loaded lines) me query search karke best matching policy/content return karta hai
async function queryKnowledgeBase(query, options = {}) {
    const rawQuery = String(query || '');
    const normalizedQuery = rawQuery
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097F\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b(wapas|wapis|wapasi|vapas|vaapas)\b/g, ' return ')
        .replace(/(रिटर्न|रिटन|रिटर्न्स)/g, ' return ')
        .replace(/(एक्सचेंज|एक्सचेन्ज)/g, ' exchange ')
        .replace(/(रिफंड|रिफन्ड)/g, ' refund ')
        .replace(/(शिपिंग|शिपमेंट)/g, ' shipping ')
        .replace(/(डिलीवरी|डेलिवरी)/g, ' delivery ')
        .replace(/(ट्रैकिंग|ट्रैक)/g, ' tracking ')
        .replace(/(पॉलिसी|पालिसी|नीति)/g, ' policy ')
        .replace(/(कॉन्टैक्ट|कॉन्टेक्ट|संपर्क)/g, ' contact ')
        .replace(/(कस्टमर\s*केयर|कस्टमर\s*केअर|सपोर्ट)/g, ' support ')
        .replace(/(वारंटी)/g, ' warranty ')
        .replace(/(भुगतान|पेमेंट)/g, ' payment ')
        .replace(/(कैश\s*ऑन\s*डिलीवरी)/g, ' cod ')
        .replace(/\b(price|pricing|plan|plans|cost|charges|monthly|month)\b/g, ' pricing ')
        .replace(/\b(feature|features|service|services|benefit|benefits)\b/g, ' features ')
        .replace(/\b(integration|integrations|crm|whatsapp|instagram|facebook|website)\b/g, ' integration ')
        .replace(/\b(multilingual|language|languages)\b/g, ' multilingual ')
        .replace(/(कैंसिल|कैंसल|कैंसलेशन)/g, ' cancel ')
        .replace(/\s+/g, ' ')
        .trim();
    const q = normalizedQuery;
    if (!q || !Array.isArray(knowledgeData) || !knowledgeData.length) {
        return { content: '', matches: [], score: 0, answer: '', normalizedQuery: q };
    }
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) {
        return { content: '', matches: [], score: 0, answer: '', normalizedQuery: q };
    }

    const policyKeywordSet = new Set([
        'return',
        'refund',
        'exchange',
        'shipping',
        'delivery',
        'tracking',
        'track',
        'policy',
        'warranty',
        'payment',
        'cod',
        'cancel',
        'contact',
        'support',
        'order',
        'pricing',
        'features',
        'integration',
        'multilingual'
    ]);
    const focusedWords = words.filter((w) => policyKeywordSet.has(w));
    const matchWords = focusedWords.length ? focusedWords : words;

    const normalizeText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const clipAround = (rawText, keywords, maxChars) => {
        const text = normalizeText(rawText);
        if (!text) return '';
        const cap = Number.isFinite(maxChars) && maxChars > 120 ? Math.floor(maxChars) : 520;
        if (text.length <= cap) return text;
        const lower = text.toLowerCase();
        let bestIdx = -1;
        for (const w of keywords) {
            const k = String(w || '').toLowerCase();
            if (!k) continue;
            const idx = lower.indexOf(k);
            if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
        }
        const anchor = bestIdx >= 0 ? bestIdx : 0;
        let start = Math.max(0, anchor - Math.floor(cap * 0.35));
        let end = Math.min(text.length, start + cap);
        const prevStop = Math.max(text.lastIndexOf('. ', start), text.lastIndexOf('? ', start), text.lastIndexOf('! ', start));
        if (prevStop >= 0 && start - prevStop < 120) start = prevStop + 2;
        const nextStopCandidates = [text.indexOf('. ', end), text.indexOf('? ', end), text.indexOf('! ', end)].filter((n) => n >= 0);
        if (nextStopCandidates.length) {
            const nextStop = Math.min(...nextStopCandidates);
            if (nextStop - end < 120) end = Math.min(text.length, nextStop + 1);
        }
        const snippet = text.slice(start, end).trim();
        const prefix = start > 0 ? '…' : '';
        const suffix = end < text.length ? '…' : '';
        return `${prefix}${snippet}${suffix}`;
    };

    const scored = knowledgeData
        .map((entry, index) => {
            const text = String(entry || '');
            const lower = text.toLowerCase();
            let score = 0;
            for (const w of matchWords) {
                if (lower.includes(w)) {
                    score += 1;
                }
            }
            return { index, text, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
    if (!scored.length) {
        return { content: '', matches: [], score: 0, answer: '', normalizedQuery: q };
    }

    const topScore = scored[0] ? scored[0].score : 0;
    const denom = Math.max(1, matchWords.length);
    const confidence = Math.max(0, Math.min(1, topScore / denom));

    const clip = !!options.clip;
    const maxMatches = Number.isFinite(options.maxMatches) && options.maxMatches > 0 ? Math.floor(options.maxMatches) : 8;
    const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 120 ? Math.floor(options.maxChars) : 520;
    const top = scored.slice(0, maxMatches).map((item) => (clip ? clipAround(item.text, matchWords, maxChars) : item.text));
    const content = top.join('\n\n');
    return { content, matches: top, score: confidence, answer: content, normalizedQuery: q };
}

async function refreshKnowledgeChunksFromUrls(pages) {
    if (!supabase || !getBotId()) {
        console.log('[KB] Supabase client or bot id missing, skipping knowledge_chunks update');
        return;
    }
    const { error: deleteError } = await supabase.from('knowledge_chunks').delete().eq('bot_id', getBotId());
    if (deleteError) {
        if (isMissingKnowledgeTable(deleteError)) {
            knowledgeChunksAvailable = false;
            console.warn('[KB] knowledge_chunks table missing; skipping DB refresh and using live KB mode');
            return;
        }
        console.error('[KB] Error deleting old knowledge_chunks rows', deleteError && deleteError.message ? deleteError.message : deleteError);
        return;
    }
    let totalChunks = 0;
    for (const url of pages) {
        try {
            console.log(`[KB] Fetching page: ${url}`);
            const { data: html } = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 8000,
                ...DIRECT_HTTP_OPTIONS
            });
            const text = cleanPageText(html);
            const chunks = chunkText(text, { maxChars: 820, minChars: 220, overlapSentences: 1 });
            const pageType = inferPageType(url);
            const result = await storeKnowledgeChunks({ pageUrl: url, pageType, chunks });
            totalChunks += result && typeof result.inserted === 'number' ? result.inserted : 0;
            console.log(`[KB] Stored ${chunks.length} chunks for ${url}`);
        } catch (e) {
            console.error('[KB] Failed to scrape page', url, e && e.message ? e.message : e);
        }
    }
    console.log(`[KB] knowledge_chunks refresh complete. Total chunks stored: ${totalChunks}`);
}

async function updateKnowledgeBaseFromWebsite() {
    const pages = getConfiguredKnowledgeUrls();
    console.log(`[KB] Starting website knowledge refresh. Total pages: ${pages.length}`);
    await refreshKnowledgeChunksFromUrls(pages);
}

// yeh live mode me directly Anhance website pages hit karke on‑the‑fly answer nikaalta hai (DB ke bina)
async function queryKnowledgeBaseLive(query, options = {}) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return { content: '', matches: [], score: 0, answer: '', normalizedQuery: '' };
    const normalizedQuery = rawQuery
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097F\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b(wapas|wapis|wapasi|vapas|vaapas)\b/g, ' return ')
        .replace(/\b(price|pricing|plan|plans|cost|charges|monthly|month)\b/g, ' pricing ')
        .replace(/\b(feature|features|service|services|benefit|benefits)\b/g, ' features ')
        .replace(/\b(integration|integrations|crm|whatsapp|instagram|facebook|website)\b/g, ' integration ')
        .replace(/\b(multilingual|language|languages)\b/g, ' multilingual ')
        .replace(/\s+/g, ' ')
        .trim();

    const qWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 2);
    const pages = getKnowledgeTopicUrls(normalizedQuery);

    const extracted = new Set();
    for (const url of pages.slice(0, 4)) {
        try {
            const { data: html } = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 6000,
                ...DIRECT_HTTP_OPTIONS
            });
            const $ = cheerio.load(html);
            $('script, style, nav, footer, header, svg, img').remove();
            const lines = $('body')
                .text()
                .replace(/\r/g, '')
                .replace(/[ \t]{2,}/g, ' ')
                .split('\n')
                .map((t) => t.trim())
                .filter((t) => t.length > 15);
            lines.forEach((line) => extracted.add(line));
        } catch (e) {}
    }

    const kbArr = [...extracted];
    if (!kbArr.length || !qWords.length) {
        return { content: '', matches: [], score: 0, answer: '', normalizedQuery };
    }

    const policyKeywordSet = new Set([
        'return',
        'refund',
        'exchange',
        'shipping',
        'delivery',
        'tracking',
        'track',
        'policy',
        'warranty',
        'payment',
        'cod',
        'cancel',
        'contact',
        'support',
        'order',
        'pricing',
        'features',
        'integration',
        'multilingual'
    ]);
    const focusedWords = qWords.filter((w) => policyKeywordSet.has(w));
    const matchWords = focusedWords.length ? focusedWords : qWords;

    const normalizeText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const clipAround = (rawText, keywords, maxChars) => {
        const text = normalizeText(rawText);
        if (!text) return '';
        const cap = Number.isFinite(maxChars) && maxChars > 120 ? Math.floor(maxChars) : 520;
        if (text.length <= cap) return text;
        const lower = text.toLowerCase();
        let bestIdx = -1;
        for (const w of keywords) {
            const k = String(w || '').toLowerCase();
            if (!k) continue;
            const idx = lower.indexOf(k);
            if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
        }
        const anchor = bestIdx >= 0 ? bestIdx : 0;
        let start = Math.max(0, anchor - Math.floor(cap * 0.35));
        let end = Math.min(text.length, start + cap);
        const prevStop = Math.max(text.lastIndexOf('. ', start), text.lastIndexOf('? ', start), text.lastIndexOf('! ', start));
        if (prevStop >= 0 && start - prevStop < 120) start = prevStop + 2;
        const nextStopCandidates = [text.indexOf('. ', end), text.indexOf('? ', end), text.indexOf('! ', end)].filter((n) => n >= 0);
        if (nextStopCandidates.length) {
            const nextStop = Math.min(...nextStopCandidates);
            if (nextStop - end < 120) end = Math.min(text.length, nextStop + 1);
        }
        const snippet = text.slice(start, end).trim();
        const prefix = start > 0 ? '…' : '';
        const suffix = end < text.length ? '…' : '';
        return `${prefix}${snippet}${suffix}`;
    };

    const scored = kbArr
        .map((entry, index) => {
            const text = String(entry || '');
            const lower = text.toLowerCase();
            let score = 0;
            for (const w of matchWords) {
                if (lower.includes(w)) score += 1;
            }
            return { index, text, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
    if (!scored.length) {
        return { content: '', matches: [], score: 0, answer: '', normalizedQuery };
    }

    const topScore = scored[0] ? scored[0].score : 0;
    const denom = Math.max(1, matchWords.length);
    const confidence = Math.max(0, Math.min(1, topScore / denom));

    const clip = !!options.clip;
    const maxMatches = Number.isFinite(options.maxMatches) && options.maxMatches > 0 ? Math.floor(options.maxMatches) : 8;
    const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 120 ? Math.floor(options.maxChars) : 520;
    const top = scored.slice(0, maxMatches).map((item) => (clip ? clipAround(item.text, matchWords, maxChars) : item.text));
    const content = top.join('\n\n');
    return { content, matches: top, score: confidence, answer: content, normalizedQuery };
}

async function fetchServiceCardsFromWebsite(force = false) {
    const now = Date.now();
    if (!force && Array.isArray(serviceCardsCache.data) && serviceCardsCache.data.length && (now - serviceCardsCache.lastFetched) < SERVICE_CARDS_TTL_MS) {
        return serviceCardsCache.data;
    }
    const baseUrl = BRAND_WEBSITE;
    const paths = WEBSITE_PATHS;
    const servicesUrl = `${baseUrl}${paths.services || '/our-services/'}`;
    try {
        const { data: html } = await axios.get(servicesUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 8000,
            ...DIRECT_HTTP_OPTIONS
        });
        const $ = cheerio.load(html);
        $('script, style, nav, footer, header, svg').remove();
        const cards = [];
        const seen = new Set();
        const headings = $('h2, h3, h4').toArray();
        headings.forEach((node) => {
            const title = normalizeSpaces($(node).text());
            if (!title || title.length < 3 || title.length > 120) return;
            const key = title.toLowerCase();
            if (seen.has(key)) return;
            const container = $(node).closest('section, .elementor-section, .wp-block-group, .wp-block-columns, .wp-block-column, .elementor-widget-container');
            const descParts = [];
            const scope = container.length ? container : $(node).parent();
            scope.find('p, li').each((idx, el) => {
                const text = normalizeSpaces($(el).text());
                if (!text || text.length < 20) return;
                if (descParts.length < 3) descParts.push(text);
            });
            const descriptionRaw = descParts.join(' ');
            const description = descriptionRaw.length > 260 ? `${descriptionRaw.slice(0, 260)}...` : descriptionRaw;
            let imageUrl = '';
            const img = scope.find('img').first();
            if (img && img.attr('src')) {
                imageUrl = buildBrandAbsoluteUrl(String(img.attr('src')));
            }
            const headingId = $(node).attr('id');
            const link = headingId ? `${servicesUrl}#${headingId}` : servicesUrl;
            cards.push({
                id: `service_${cards.length + 1}`,
                name: title,
                description,
                link,
                imageUrl
            });
            seen.add(key);
        });
        if (!cards.length) {
            const fallbackItems = [];
            $('ul li, ol li').each((idx, el) => {
                const text = normalizeSpaces($(el).text());
                if (!text || text.length < 12) return;
                if (fallbackItems.length < 8) fallbackItems.push(text);
            });
            fallbackItems.forEach((text, idx) => {
                cards.push({
                    id: `service_fallback_${idx + 1}`,
                    name: text,
                    description: '',
                    link: servicesUrl,
                    imageUrl: ''
                });
            });
        }
        serviceCardsCache = { data: cards, lastFetched: now };
        return cards;
    } catch (e) {
        return [];
    }
}

async function fetchPricingPlansFromWebsite(force = false) {
    const now = Date.now();
    if (!force && Array.isArray(pricingCardsCache.data) && pricingCardsCache.data.length && (now - pricingCardsCache.lastFetched) < PRICING_CARDS_TTL_MS) {
        return pricingCardsCache.data;
    }
    const baseUrl = BRAND_WEBSITE;
    const paths = WEBSITE_PATHS;
    const pricingUrl = `${baseUrl}${paths.pricing || '/pricing/'}`;
    try {
        const { data: html } = await axios.get(pricingUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 8000,
            ...DIRECT_HTTP_OPTIONS
        });
        const $ = cheerio.load(html);
        $('script, style, nav, footer, header, svg').remove();
        const cards = [];
        const seen = new Set();
        const candidates = $('div, section, article').toArray();
        candidates.forEach((node) => {
            const block = $(node);
            const text = normalizeSpaces(block.text());
            if (!text) return;
            if (!text.includes('₹') && !text.includes('Rs') && !text.includes('INR')) return;
            const lower = text.toLowerCase();
            if (!lower.includes('month') && !lower.includes('year') && !lower.includes('plan')) return;
            if (text.length < 40 || text.length > 900) return;
            const price = extractPriceFromText(text);
            if (!price) return;
            const period = extractBillingPeriod(text);
            const heading = block.find('h2, h3, h4, strong').first();
            const name = normalizeSpaces(heading.text()) || 'Plan';
            const key = `${name.toLowerCase()}|${price}`;
            if (seen.has(key)) return;
            const features = [];
            block.find('li').each((idx, el) => {
                const feat = normalizeSpaces($(el).text());
                if (!feat || feat.length < 6) return;
                if (features.length < 8) features.push(feat);
            });
            const link = pricingUrl;
            cards.push({
                id: `pricing_${cards.length + 1}`,
                name,
                price: `${price}${period}`,
                features,
                link
            });
            seen.add(key);
        });
        pricingCardsCache = { data: cards, lastFetched: now };
        return cards;
    } catch (e) {
        return [];
    }
}

// New function that uses centralized scraping configuration
async function fetchUrlsFromCentralizedConfig(groupNames = ['main_pages'], options = {}) {
    try {
        let urls = [];
        
        // Get URLs from specified groups
        if (Array.isArray(groupNames)) {
            urls = scrapeSources.getUrlsByGroups(groupNames);
        } else {
            urls = scrapeSources.getUrlsByGroup(groupNames);
        }
        
        // Validate URLs
        urls = scrapeSources.validateUrls(urls);
        
        // Remove duplicates
        urls = [...new Set(urls)];
        
        // Log scraping information
        console.log(`[Scraper] Loaded ${urls.length} URLs from groups: ${Array.isArray(groupNames) ? groupNames.join(', ') : groupNames}`);
        
        return {
            urls,
            totalUrls: urls.length,
            groups: Array.isArray(groupNames) ? groupNames : [groupNames]
        };
    } catch (error) {
        console.error('[Scraper] Error loading URLs from centralized config:', error.message);
        return {
            urls: [],
            totalUrls: 0,
            groups: [],
            error: error.message
        };
    }
}

// Enhanced version of updateKnowledgeBaseFromWebsite using centralized config
async function updateKnowledgeBaseFromWebsiteEnhanced(groupNames = ['main_pages', 'policy_pages']) {
    const { urls: pages, totalUrls } = await fetchUrlsFromCentralizedConfig(groupNames);
    
    if (totalUrls === 0) {
        console.log('[KB] No URLs found in centralized configuration');
        return;
    }
    
    console.log(`[KB] Starting website knowledge refresh. Total pages: ${totalUrls}`);
    await refreshKnowledgeChunksFromUrls(pages);
}

module.exports = {
    axiosGetWithHardTimeout,
    enrichProductsWithPageExtras,
    getProductCodeStatus,
    getProductDetailsByCode,
    getLiveProducts,
    getRecommendedProductsForProduct,
    getProductCacheInfo,
    fetchContactInfoFromWebsite,
    fetchServiceCardsFromWebsite,
    fetchPricingPlansFromWebsite,
    loadKnowledgeData,
    queryKnowledgeBase,
    queryKnowledgeChunks,
    updateKnowledgeBaseFromWebsite,
    queryKnowledgeBaseLive,
    // New centralized configuration functions
    fetchUrlsFromCentralizedConfig,
    updateKnowledgeBaseFromWebsiteEnhanced
};
