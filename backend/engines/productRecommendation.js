const botConfig = require('../config/bot_prompts');
const BRAND_NAME = botConfig.company.company_name || 'AI Assistant';
const BRAND_WEBSITE = String(botConfig.company.website_url || 'https://phdbeauty.com').replace(/\/$/, '');

function normalizeProductLink(link) {
    const s = String(link || '').trim();
    if (!s) return '';
    const m = s.match(/\/product[s]?\/([^\/\?#]+)/i);
    if (m && m[1]) {
        return `${BRAND_WEBSITE}/product/${m[1]}`;
    }
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return `${BRAND_WEBSITE}${s}`;
    return '';
}

// yeh function user ke search query ko samajh kar Nutrabay catalog me relevant products dhoondhta hai
async function searchProducts(args) {
    const {
        userQuery,
        sortBy,
        socket,
        getLiveProducts,
        getProductCodeStatus,
        getUserState,
        userStates,
        sendMessage,
        vectorSearch,
        ranker,
        callOpenAI,
        show_more_products
    } = args;

    const allProductsOriginal = await getLiveProducts();
    const state = getUserState(socket.user_id);
    let allProducts = allProductsOriginal;
    let filteredProducts = [];

    const uqLower = String(userQuery || '').toLowerCase();
    const uqRaw = String(userQuery || '');

    const detectCategoryFromQuery = (text) => {
        const s = String(text || '').toLowerCase();
        const categories = [
            { key: 'whey', tokens: ['whey', 'protein powder', 'wpc', 'isolate', 'concentrate'] },
            { key: 'creatine', tokens: ['creatine', 'monohydrate'] },
            { key: 'pre workout', tokens: ['pre workout', 'preworkout', 'energy drink'] },
            { key: 'fish oil', tokens: ['fish oil', 'omega 3', 'omega-3'] },
            { key: 'multivitamin', tokens: ['multivitamin', 'multivitamins', 'vitamins'] },
            { key: 'protein bars', tokens: ['protein bar', 'protein bars', 'bar'] },
            { key: 'oats', tokens: ['oats', 'protein oats'] },
            { key: 'peanut butter', tokens: ['peanut butter'] }
        ];
        for (const cat of categories) {
            if (cat.tokens.some(t => s.includes(t))) return cat.key;
        }
        return null;
    };

    const hasIdIntent = /\b(code|sku|style\s*code|article)\b/i.test(uqRaw);
    const hasLongNumber = /\b\d{3,6}\b/.test(uqRaw);
    const isNumericOnly = /^\s*\d{3,6}\s*$/.test(String(userQuery || ''));
    const isSpecificIdQuery = hasIdIntent && hasLongNumber;
    let isRandomRequest = /\b(random|kuch\s*bhi|koi\s*bhi|any\s+product)\b/i.test(uqLower);
    const detectedCategoryKey = detectCategoryFromQuery(uqLower);
    const uq = String(userQuery || '').toLowerCase();
    const words = String(userQuery || '').trim().split(/\s+/).filter(w => w.length > 2);
    const isGreeting = /\b(hi|hello|hey|hola|namaste|yo)\b/i.test(uq);
    const isPolicyQuestion = /(return|exchange|shipping|delivery|refund|policy|terms|about|contact)/.test(uq);
    const isOccasionQuery = /\b(farewell|farewell\s+party|party|wedding|shaadi|shadi|sangeet|reception|function|festival|festive|engagement|office\s+party|birthday|anniversary|office|college)\b/.test(uq);
    const isSeasonQuery = /\b(rainy|rain|monsoon|baarish|barish|garmi|summer|winter|sardi|sardii?)\b/.test(uq);
    const hasSupplementContext = /\b(whey|protein|isolate|concentrate|mass gainer|gainer|creatine|monohydrate|pre\s*workout|preworkout|bcaa|amino|l-carnitine|fish oil|omega\s*3|multivitamin|vitamin|ashwagandha|magnesium|collagen|shilajit|peanut butter|oats|protein bar|bars|plant protein|pea protein|vegan protein|workout|gym|muscle|recovery|strength|weight gain|fat loss)\b/.test(uq);
    const hasFootwearContext = /\b(shoe|shoes|footwear|sneaker|sneakers|loafer|loafers|sandal|sandals|chappal|slipper|slippers|flip\s*flops?|boot|boots)\b/.test(uq);
    const isScenarioQuery = (isOccasionQuery || isSeasonQuery || hasSupplementContext) && !isPolicyQuestion && !isNumericOnly && (words.length >= 2 || hasSupplementContext);

    if (!detectedCategoryKey && !isSpecificIdQuery && !isRandomRequest && !isNumericOnly && !isScenarioQuery && !isGreeting && !hasFootwearContext) {
        isRandomRequest = true;
    }

    const buildLanguageAwareExactMissMessage = async () => {
        if (typeof callOpenAI !== 'function') return null;
        const langCode = state && typeof state.languageCode === 'string' ? state.languageCode : 'auto';
        const langPrompt = langCode && langCode !== 'auto'
            ? (langCode === 'hi'
                ? 'Respond ONLY in Hinglish: Hindi written using English/Latin alphabets. Do not use Devanagari or Hindi script.'
                : `Respond ONLY in the language with code "${langCode}".`)
            : `Detect the user language from this message and respond in that same language or mix (for example Hindi, English, or Hinglish): "${userQuery}". When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only and do not use Devanagari or Hindi script.`;
        const system = [
            `You are ${BRAND_NAME} shopping and style assistant.`,
            'Write one short sentence under 40 words.',
            'Plain text only, no bullets, no markdown.',
            'Clearly say that the exact product the shopper asked for is not available.',
            'Then invite them to check similar or alternative options being shown.'
        ].join(' ');
        const user = `User request: "${userQuery}".`;
        const resp = await callOpenAI([
            { role: 'system', content: system },
            { role: 'system', content: langPrompt },
            { role: 'user', content: user }
        ], false);
        const txt = resp && resp.success && resp.data && resp.data.message && resp.data.message.content
            ? String(resp.data.message.content).trim()
            : "";
        return txt || null;
    };

    const sendExactPreferenceMissingMessage = async () => {
        let msg = null;
        try {
            msg = await buildLanguageAwareExactMissMessage();
        } catch (e) { }
        if (!msg) {
            const langCode = state && typeof state.languageCode === 'string' ? state.languageCode : 'auto';
            msg = langCode === 'hi'
                ? (botConfig.phrases.exact_miss_hi || "Sorry, ye exact product abhi available nahi hai. Main closest alternate options dikha raha hoon:")
                : (botConfig.phrases.exact_miss || "Sorry, this exact product is not available right now. Here are the closest alternatives:");
        }
        await sendMessage(socket, msg, socket.user_id);
    };

    const buildLanguageAwareNoMatchMessage = async () => {
        if (typeof callOpenAI !== 'function') return null;
        const langCode = state && typeof state.languageCode === 'string' ? state.languageCode : 'auto';
        const langPrompt = langCode && langCode !== 'auto'
            ? (langCode === 'hi'
                ? 'Respond ONLY in Hinglish: Hindi written using English/Latin alphabets. Do not use Devanagari or Hindi script.'
                : `Respond ONLY in the language with code "${langCode}".`)
            : `Detect the user language from this message and respond in that same language or mix (for example Hindi, English, or Hinglish): "${userQuery}". When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only and do not use Devanagari or Hindi script.`;
        const system = [
            `You are ${BRAND_NAME} shopping and style assistant.`,
            'Write one short sentence under 40 words.',
            'Plain text only, no bullets, no markdown.',
            'Say that no exact match is available right now for the request.',
            'Then say you are showing the closest alternatives.'
        ].join(' ');
        const user = `User request: "${userQuery}".`;
        const resp = await callOpenAI([
            { role: 'system', content: system },
            { role: 'system', content: langPrompt },
            { role: 'user', content: user }
        ], false);
        const txt = resp && resp.success && resp.data && resp.data.message && resp.data.message.content
            ? String(resp.data.message.content).trim()
            : "";
        return txt || null;
    };

    const sendNoMatchButAlternativesMessage = async () => {
        let msg = null;
        try {
            msg = await buildLanguageAwareNoMatchMessage();
        } catch (e) { }
        if (!msg) {
            const langCode = state && typeof state.languageCode === 'string' ? state.languageCode : 'auto';
            msg = langCode === 'hi'
                ? (botConfig.phrases.no_match_alternatives_hi || "Sorry, is request ka exact product/option abhi nahi mila. Main closest alternate options dikha raha hoon:")
                : (botConfig.phrases.no_match_alternatives || "Sorry, we don’t have an exact match for this right now. Here are the closest alternatives:");
        }
        await sendMessage(socket, msg, socket.user_id);
    };

    const detectPriceRangeFromQuery = (text) => {
        const s = String(text || '');
        if (!s) return null;
        const normalized = s.replace(/[,]/g, ' ');
        const patterns = [
            /\b(?:between|from)\s*(?:₹|rs\.?\s*)?(\d{3,6})\s*(?:and|to|-)\s*(?:₹|rs\.?\s*)?(\d{3,6})\b/i,
            /\b(?:range|price\s*range)\s*(?:₹|rs\.?\s*)?(\d{3,6})\s*(?:to|-)\s*(?:₹|rs\.?\s*)?(\d{3,6})\b/i,
            /\b(\d{3,6})\s*(?:se|to)\s*(\d{3,6})\s*(?:ke\s*(?:beech|bich)|tak)\b/i,
            /\b(\d{3,6})\s*(?:-|to)\s*(\d{3,6})\s*(?:range|between|ke\s*(?:beech|bich))\b/i
        ];
        for (const re of patterns) {
            const m = normalized.match(re);
            if (!m) continue;
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const min = Math.min(a, b);
            const max = Math.max(a, b);
            if (min < 100 || max < 100 || max - min < 50) continue;
            return { min, max };
        }
        return null;
    };

    const detectBudgetFromQuery = (text) => {
        const s = String(text || '');
        const budgetContext = /(₹|rs\.?\b|rupees?\b|inr\b|budget\b|under\b|below\b|less\s+than\b|upto\b|up\s+to\b|within\b|ke\s+andar\b|se\s+kam\b|tak\b)/i;
        const codePricePattern = /\b\d{3,6}\b\s*(?:ka|ki|ke)\s*(?:price|rate|mrp|cost)\b/i;
        if (codePricePattern.test(s) && !/(under|below|less\s+than|upto|up\s+to|within|ke\s+andar|se\s+kam|tak|budget)/i.test(s)) {
            return null;
        }
        if (!budgetContext.test(s)) return null;

        const matches = [];
        const re = /\d{3,6}/g;
        let m;
        while ((m = re.exec(s)) !== null) {
            const num = m[0];
            const start = Math.max(0, m.index - 20);
            const end = Math.min(s.length, m.index + num.length + 20);
            const window = s.slice(start, end);
            if (budgetContext.test(window)) {
                const n = parseInt(num, 10);
                if (Number.isFinite(n)) matches.push(n);
            }
        }
        if (!matches.length) return null;
        return matches[matches.length - 1];
    };

    const detectPeopleCountFromQuery = (text) => {
        const s = String(text || '').toLowerCase();
        const digitMatch = s.match(/(\d+)\s*(?:log|logo?n|people|persons?|pairs?|jode?)/);
        if (digitMatch) {
            const n = parseInt(digitMatch[1], 10);
            if (Number.isFinite(n) && n >= 2 && n <= 10) return n;
        }
        if (/\b(hum\s*dono|dono\s*ke\s*liye|do\s*logo?n\s*ke\s*liye|me\s*and\s*my|mujhe\s*aur\s*meri|mere\s*aur\s*meri)\b/.test(s)) {
            return 2;
        }
        return null;
    };

    const priceRange = detectPriceRangeFromQuery(uqRaw);
    const minPrice = priceRange ? priceRange.min : null;
    const maxPrice = priceRange ? priceRange.max : null;
    const budget = priceRange ? null : detectBudgetFromQuery(uqRaw);
    const peopleCount = detectPeopleCountFromQuery(uqRaw);
    let budgetPerItem = budget;
    if (budget && Number.isFinite(budget) && peopleCount && peopleCount > 1) {
        const s = String(uqRaw || '').toLowerCase();
        const numStr = String(budget);
        const idx = s.indexOf(numStr);
        const start = idx === -1 ? 0 : Math.max(0, idx - 30);
        const end = idx === -1 ? s.length : Math.min(s.length, idx + numStr.length + 30);
        const window = s.slice(start, end);
        const totalMarkers = /(total\s+budget|combined\s+budget|overall\s+budget)/i;
        const multiMarkers = /(dono\s+ke\s+liye|hum\s*dono|for\s+both|for\s+two|for\s+2\s*(?:people|persons?|pairs?))/i;
        if (totalMarkers.test(window) || multiMarkers.test(window)) {
            const per = Math.floor(budget / peopleCount);
            if (per > 0) budgetPerItem = per;
        }
    }
    const excludeHeels = /(?:\bheels?\b|\bheel\b).{0,12}\b(mat|nahi|nahin|no|not|dont|don't|do\s+not|without|avoid)\b|\b(mat|nahi|nahin|no|not|dont|don't|do\s+not|without|avoid)\b.{0,12}(?:\bheels?\b|\bheel\b)/i.test(uqRaw);

    const isHeelProduct = (p) => {
        const t = `${p && p.name ? p.name : ''} ${p && p.category ? p.category : ''} ${(p && Array.isArray(p.tags)) ? p.tags.join(' ') : ''}`.toLowerCase();
        return /\b(heel|heels|stiletto)\b/.test(t);
    };

    const applyConstraints = (products) => {
        let out = Array.isArray(products) ? products : [];
        if (minPrice && maxPrice && Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
            out = out.filter(p => {
                const np = Number(p && p.numericPrice);
                return Number.isFinite(np) && np > 0 && np >= minPrice && np <= maxPrice;
            });
        }
        if (budgetPerItem && Number.isFinite(budgetPerItem)) {
            out = out.filter(p => {
                const np = Number(p && p.numericPrice);
                return Number.isFinite(np) && np > 0 && np <= budgetPerItem;
            });
        }
        if (excludeHeels) {
            out = out.filter(p => !isHeelProduct(p));
        }
        return out;
    };

    const pickCuratedAlternatives = (baseProducts) => {
        const baseArr = Array.isArray(baseProducts) ? baseProducts : [];
        const constrainedBase = applyConstraints(baseArr);
        const pool = constrainedBase.length ? constrainedBase : baseArr;
        const sale = pool.filter(p => p && p.isOnSale === true);
        if (sale.slice(0, 9).length >= 3) return sale.slice(0, 9);
        const score = (p) => {
            const r = Number(p && p.rating);
            const rc = Number(p && p.reviewCount);
            const hasR = Number.isFinite(r) ? r : 0;
            const hasRc = Number.isFinite(rc) ? rc : 0;
            const price = Number(p && p.numericPrice);
            const hasPrice = Number.isFinite(price) ? price : 0;
            return (hasR * 100000) + (hasRc * 1000) + hasPrice;
        };
        return [...pool].sort((a, b) => score(b) - score(a)).slice(0, 9);
    };

    const constrained = applyConstraints(allProducts);
    if (constrained.length) {
        allProducts = constrained;
    } else if (minPrice && maxPrice && Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
        const sorted = [...allProductsOriginal].filter(p => Number.isFinite(Number(p && p.numericPrice))).sort((a, b) => {
            const da = Math.abs(Number(a.numericPrice) - ((minPrice + maxPrice) / 2));
            const db = Math.abs(Number(b.numericPrice) - ((minPrice + maxPrice) / 2));
            return da - db;
        });
        const picks = sorted.slice(0, 9);
        if (!socket.isWhatsApp) {
            await sendMessage(socket, `Is exact range (Rs. ${minPrice} to Rs. ${maxPrice}) me products nahi mile. Main closest options dikha raha hoon:`, socket.user_id);
        }
        const st = getUserState(socket.user_id);
        st.lastSearchResults = picks;
        st.lastQueryProducts = picks;
        st.productViewIndex = 0;
        userStates.set(socket.user_id, st);
        await show_more_products({}, socket);
        return JSON.stringify({ success: false, summary: `No products in range Rs. ${minPrice}-${maxPrice}; displayed closest options.`, totalMatches: picks.length });
    }

    const isExactPreferenceMissing = (query) => {
        const q = String(query || '').toLowerCase();
        const products = Array.isArray(allProducts) ? allProducts : [];
        if (!products.length) return false;
        const textOf = (p) => {
            const base = `${p && p.name ? p.name : ''} ${p && p.category ? p.category : ''} ${(Array.isArray(p && p.tags) ? p.tags.join(' ') : '')}`;
            const colors = Array.isArray(p && p.colors) ? p.colors.join(' ') : '';
            return `${base} ${colors}`.toLowerCase();
        };
        const wantsSports = /\b(running|runner|sport\s*shoe|sports\s*shoe|sports\s*shoes|sport\s*shoes|sneaker|sneakers|jogging)\b/.test(q);
        const colorWords = ['neon', 'green', 'blue', 'red', 'black', 'white', 'pink', 'beige', 'brown', 'tan', 'nude', 'gold', 'silver'];
        const wantedColors = colorWords.filter(c => q.includes(c));
        if (!wantsSports && !wantedColors.length) return false;
        const hasExact = products.some(p => {
            const t = textOf(p);
            if (wantsSports && !/\b(running|runner|sport|sports|sneaker|sneakers|jogging)\b/.test(t)) return false;
            if (wantedColors.length) {
                const hasColor = wantedColors.some(c => t.includes(c));
                if (!hasColor) return false;
            }
            return true;
        });
        return !hasExact;
    };

    if (!socket.isWhatsApp) {
        const parts = [`Main ${BRAND_NAME} ke live product catalog me search kar raha hoon.`];
        const filters = [];
        if (minPrice && maxPrice && Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
            filters.push(`Rs. ${minPrice} se Rs. ${maxPrice} ke beech`);
        }
        if (budget && Number.isFinite(budget)) {
            if (budgetPerItem && Number.isFinite(budgetPerItem) && peopleCount && peopleCount > 1 && budgetPerItem !== budget) {
                filters.push(`Total budget Rs. ${budget} (approx Rs. ${budgetPerItem} per person)`);
            } else {
                filters.push(`Rs. ${budget} ke andar`);
            }
        }
        if (excludeHeels) filters.push("heels exclude");
        if (filters.length) parts.push(`Filters: ${filters.join(', ')}.`);
        await sendMessage(socket, parts.join(' '), socket.user_id);
    }

    if (isRandomRequest) {
        let picks = pickCuratedAlternatives(allProductsOriginal);
        try {
            picks = ranker.rankProducts(picks, getUserState(socket.user_id), "");
        } catch (e) { }
        const st = getUserState(socket.user_id);
        st.lastSearchResults = picks;
        st.lastQueryProducts = picks;
        st.productViewIndex = 0;
        userStates.set(socket.user_id, st);
        await show_more_products({}, socket);
        return JSON.stringify({
            success: true,
            summary: `Displayed ${picks.length} curated products for a generic browse request.`,
            totalMatches: picks.length
        });
    }

    const wantsCheapest = /(cheapest|lowest\s+price|sbse\s+sasta|sabse\s+sasta|sabse\s+cheap|sasta\s+product|sabse\s+kam\s+price)/i.test(uqLower);
    const wantsMostExpensive = /(most\s+expensive|highest\s+price|sbse\s+mehenga|sabse\s+mehenga|sabse\s+mehnge|costliest|sabse\s+mahanga)/i.test(uqLower);

    if (wantsCheapest || wantsMostExpensive) {
        const productsWithPrice = allProducts.filter(p => typeof p.numericPrice === 'number' && !Number.isNaN(p.numericPrice));
        if (productsWithPrice.length) {
            const sortedByPrice = [...productsWithPrice].sort((a, b) =>
                wantsCheapest ? a.numericPrice - b.numericPrice : b.numericPrice - a.numericPrice
            );
            const chosen = sortedByPrice[0];
            filteredProducts = chosen ? [chosen] : [];
            const st = getUserState(socket.user_id);
            st.lastSearchResults = filteredProducts;
            st.lastQueryProducts = filteredProducts;
            st.productViewIndex = 0;
            userStates.set(socket.user_id, st);
            await show_more_products({}, socket);
            if (chosen) {
                return JSON.stringify({
                    success: true,
                    summary: wantsCheapest
                        ? `Returned the lowest priced product for "${userQuery}" and displayed it in the UI.`
                        : `Returned the highest priced product for "${userQuery}" and displayed it in the UI.`,
                    totalMatches: filteredProducts.length
                });
            }
        }
    }

    const trimmedQuery = String(userQuery || '').trim();
    if (trimmedQuery) {
        const tqLower = trimmedQuery.toLowerCase();
        const exactById = new Map();
        for (const p of Array.isArray(allProductsOriginal) ? allProductsOriginal : []) {
            if (!p) continue;
            const id = p.id != null ? String(p.id) : null;
            const name = p.name != null ? String(p.name).trim().toLowerCase() : '';
            if (name && name === tqLower) {
                if (id && !exactById.has(id)) exactById.set(id, p);
                continue;
            }
            const skus = Array.isArray(p.skus) ? p.skus : [];
            const hasExactSku = skus.some(s => String(s).trim().toLowerCase() === tqLower);
            if (hasExactSku) {
                if (id && !exactById.has(id)) exactById.set(id, p);
                continue;
            }
            const codesArr = Array.isArray(p.codes) ? p.codes : [];
            const hasExactCode = codesArr.some(c => String(c).trim().toLowerCase() === tqLower);
            if (hasExactCode) {
                if (id && !exactById.has(id)) exactById.set(id, p);
                continue;
            }
        }
        const exactMatches = Array.from(exactById.values());
        if (exactMatches.length === 1) {
            filteredProducts = exactMatches.slice();
            try {
                filteredProducts = ranker.rankProducts(filteredProducts, getUserState(socket.user_id), userQuery || "");
            } catch (e) { }
            const st = getUserState(socket.user_id);
            st.lastSearchResults = filteredProducts;
            st.lastQueryProducts = filteredProducts;
            st.productViewIndex = 0;
            userStates.set(socket.user_id, st);
            await show_more_products({}, socket);
            return JSON.stringify({
                success: true,
                summary: `Found 1 exact product for "${userQuery}" and displayed it in the UI.`,
                totalMatches: filteredProducts.length
            });
        }
    }

    const directMatches = findDirectNameMatches(allProducts, userQuery);
    if (directMatches.length > 0) {
        filteredProducts = [directMatches[0]];
        try {
            filteredProducts = ranker.rankProducts(filteredProducts, getUserState(socket.user_id), userQuery || "");
        } catch (e) { }
        const st = getUserState(socket.user_id);
        st.lastSearchResults = filteredProducts;
        st.lastQueryProducts = filteredProducts;
        st.productViewIndex = 0;
        userStates.set(socket.user_id, st);
        await show_more_products({}, socket);
        return JSON.stringify({
            success: true,
            summary: `Found 1 product matching "${userQuery}" and displayed it in the UI.`,
            totalMatches: filteredProducts.length
        });
    }

    const isBudgetishNumber = (text, numStr) => {
        if (!numStr) return false;
        const s = String(text || '');
        const idx = s.indexOf(numStr);
        if (idx === -1) return false;
        const start = Math.max(0, idx - 20);
        const end = Math.min(s.length, idx + numStr.length + 20);
        const window = s.slice(start, end);
        return /(₹|rs\.?\b|rupees?\b|inr\b|budget\b|under\b|below\b|less\s+than\b|upto\b|up\s+to\b|within\b|ke\s+andar\b|se\s+kam\b|tak\b)/i.test(window);
    };
    const isRangeishNumber = (text, numStr) => {
        if (!numStr) return false;
        const s = String(text || '');
        const idx = s.indexOf(numStr);
        if (idx === -1) return false;
        const start = Math.max(0, idx - 24);
        const end = Math.min(s.length, idx + numStr.length + 24);
        const window = s.slice(start, end);
        return /(range|between|from|to|se|tak|ke\s*(beech|bich)|₹|rs\.?\b|rupees?\b|inr\b)/i.test(window);
    };

    const numericCandidates = (userQuery && userQuery.match(/\d{3,6}/g)) || [];
    const rangeNums = new Set();
    if (minPrice && maxPrice) {
        rangeNums.add(String(minPrice));
        rangeNums.add(String(maxPrice));
    }
    const codesInQuery = numericCandidates.filter(code => {
        if (rangeNums.has(String(code))) return false;
        if (budget && String(code) === String(budget)) return false;
        if (isBudgetishNumber(userQuery, code)) return false;
        if (isRangeishNumber(userQuery, code)) return false;
        return true;
    });

    const skuTokensInQuery = (() => {
        const out = [];
        const re = /\b(?:sku|style\s*code|article)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-]{2,20})\b/ig;
        const text = String(userQuery || '');
        let m;
        while ((m = re.exec(text)) !== null) {
            const token = m[1] ? String(m[1]).trim() : '';
            if (!token) continue;
            if (!out.includes(token)) out.push(token);
        }
        return out;
    })();

    const codeSearchKeys = [...codesInQuery, ...skuTokensInQuery];

    const buildCodeStatusMessage = (codes) => {
        const st = state && typeof state === 'object' ? state : {};
        const langCode = typeof st.languageCode === 'string' ? st.languageCode : 'auto';
        const statusFn = typeof getProductCodeStatus === 'function' ? getProductCodeStatus : null;

        const outOfStock = [];
        const notFound = [];
        for (const c of codes) {
            const status = statusFn ? statusFn(c) : 'unknown';
            if (status === 'out_of_stock') outOfStock.push(String(c));
            else if (status === 'not_found') notFound.push(String(c));
        }
        const codesStr = codes.map(String).join(', ');

        const isHindi = langCode === 'hi';
        if (outOfStock.length && !notFound.length) {
            return isHindi
                ? `Aapka product code ${codesStr} abhi out of stock hai. Main similar available options dikha raha hoon:`
                : `The product code ${codesStr} is currently out of stock. Showing similar available options:`;
        }
        if (!outOfStock.length && notFound.length) {
            return isHindi
                ? `Is product code ${codesStr} ka hamare database me koi match nahi mila. Main similar options dikha raha hoon:`
                : `No match found in our database for product code ${codesStr}. Showing similar options:`;
        }
        if (outOfStock.length && notFound.length) {
            const oosStr = outOfStock.join(', ');
            const nfStr = notFound.join(', ');
            return isHindi
                ? `Kuch codes out of stock hain (${oosStr}) aur kuch ka match nahi mila (${nfStr}). Main similar available options dikha raha hoon:`
                : `Some codes are out of stock (${oosStr}) and some have no database match (${nfStr}). Showing similar available options:`;
        }
        return null;
    };

    const maybeSendCodeStatusMessage = async (codes) => {
        const msg = buildCodeStatusMessage(codes);
        if (msg) {
            await sendMessage(socket, msg, socket.user_id);
            return true;
        }
        return false;
    };

    if (codeSearchKeys.length > 0) {
        filteredProducts = allProducts.filter(p => (
            codeSearchKeys.some(code => {
                const codeStr = String(code);
                const isNumeric = /^\d{3,6}$/.test(codeStr);
                const codesArr = Array.isArray(p.codes) ? p.codes.map(x => String(x)) : [];
                if (isNumeric) {
                    const re = new RegExp("\\b" + codeStr + "\\b", "i");
                    if (codesArr.includes(codeStr)) return true;
                    if (p.name && re.test(String(p.name))) return true;
                    if (Array.isArray(p.skus) && p.skus.some(s => re.test(String(s)))) return true;
                    if (Array.isArray(p.tags) && p.tags.some(t => re.test(String(t)))) return true;
                    return false;
                }
                if (codesArr.includes(codeStr)) return true;
                if (p.name && String(p.name).includes(codeStr)) return true;
                if (Array.isArray(p.skus) && p.skus.some(s => String(s).includes(codeStr))) return true;
                if (Array.isArray(p.tags) && p.tags.some(t => String(t).includes(codeStr))) return true;
                return false;
            })
        ));

        if (filteredProducts.length > 0 && codesInQuery.length > 0) {
            const codesStr = codesInQuery.map(String).join(', ');
            const count = filteredProducts.length;
            const msg = count === 1
                ? `I found one product matching code ${codesStr}. Please click the product card for details or ask me if you want more information.`
                : `I found ${count} products matching codes ${codesStr}. Please click a product card for details or ask me if you want more information.`;
            await sendMessage(socket, msg, socket.user_id);
        }

        if (filteredProducts.length === 0) {
            const sent = await maybeSendCodeStatusMessage(codesInQuery);
            if (!sent) await sendExactPreferenceMissingMessage();
            const vectorResults = await vectorSearch.semanticSearch(userQuery, 9);
            const productMap = new Map(allProducts.map(p => [String(p.id), p]));
            let semProducts = vectorResults.map(r => productMap.get(String(r.id))).filter(Boolean);
            semProducts = applyConstraints(semProducts);
            try {
                semProducts = ranker.rankProducts(semProducts, getUserState(socket.user_id), userQuery || "");
            } catch (e) { }
            if (semProducts.length) {
                const st = getUserState(socket.user_id);
                st.lastSearchResults = semProducts;
                st.lastQueryProducts = semProducts;
                st.productViewIndex = 0;
                userStates.set(socket.user_id, st);
                await show_more_products({ catalog_mode: 'append' }, socket);
                return JSON.stringify({ success: true, summary: `Found ${semProducts.length} semantically similar products for "${userQuery}" and displayed them in the UI.`, totalMatches: semProducts.length });
            }
            const baseForFallback = allProductsOriginal;
            const constrainedFallback = applyConstraints(baseForFallback);
            const fallbackProducts = constrainedFallback.length ? constrainedFallback : baseForFallback;
            const recommended = (fallbackProducts.filter(p => p.isOnSale).slice(0, 9).length >= 3)
                ? fallbackProducts.filter(p => p.isOnSale).slice(0, 9)
                : [...fallbackProducts].sort((a, b) => b.numericPrice - a.numericPrice).slice(0, 9);
            const currentStateFallback = getUserState(socket.user_id);
            currentStateFallback.lastSearchResults = recommended;
            currentStateFallback.productViewIndex = 0;
            userStates.set(socket.user_id, currentStateFallback);
            await show_more_products({ catalog_mode: 'append' }, socket);
            return JSON.stringify({ success: false, summary: "No direct code match; displayed curated alternatives in the UI.", totalMatches: recommended.length });
        }

        await maybeSendCodeStatusMessage(codesInQuery);
        try {
            filteredProducts = ranker.rankProducts(filteredProducts, getUserState(socket.user_id), userQuery || "");
        } catch (e) { }
        const currentStateDirect = getUserState(socket.user_id);
        currentStateDirect.lastSearchResults = filteredProducts;
        currentStateDirect.lastQueryProducts = filteredProducts;
        currentStateDirect.productViewIndex = 0;
        userStates.set(socket.user_id, currentStateDirect);

        await show_more_products({}, socket);

        return JSON.stringify({
            success: true,
            summary: `Found ${filteredProducts.length} product(s) matching ${codeSearchKeys.join(', ')}.`,
            totalMatches: filteredProducts.length
        });
    }

    if (isScenarioQuery && vectorSearch && typeof vectorSearch.semanticSearch === 'function') {
        const vectorResultsScenario = await vectorSearch.semanticSearch(userQuery, 9);
        const productMapScenario = new Map(allProducts.map(p => [String(p.id), p]));
        let scenarioProducts = vectorResultsScenario.map(r => productMapScenario.get(String(r.id))).filter(Boolean);
        scenarioProducts = applyConstraints(scenarioProducts);
        try {
            scenarioProducts = ranker.rankProducts(scenarioProducts, getUserState(socket.user_id), userQuery || "");
        } catch (e) { }
        const stScenario = userStates.get(socket.user_id) || {};
        userStates.set(socket.user_id, { ...stScenario, lastSearchResults: scenarioProducts, lastQueryProducts: scenarioProducts, productViewIndex: 0 });
        if (!scenarioProducts.length) {
            const recommended = pickCuratedAlternatives(allProductsOriginal);
            if (recommended.length) {
                await sendNoMatchButAlternativesMessage();
                const st = getUserState(socket.user_id);
                st.lastSearchResults = recommended;
                st.lastQueryProducts = recommended;
                st.productViewIndex = 0;
                userStates.set(socket.user_id, st);
                await show_more_products({ catalog_mode: 'replace' }, socket);
                return JSON.stringify({ success: false, summary: "No scenario matches; displayed curated alternatives in the UI.", totalMatches: recommended.length });
            }
            await sendMessage(socket, "Sorry, we do not have any products matching this request right now.", socket.user_id);
            return JSON.stringify({ success: false, summary: "No products found matching the scenario query.", totalMatches: 0 });
        }
        try {
            console.log("INTENT_FLOW", {
                user_id: socket && socket.user_id ? socket.user_id : null,
                message: String(userQuery || ""),
                route: "scenario_recommendation",
                functionHit: "search_products"
            });
        } catch (e) { }
        await show_more_products({}, socket);
        const prefMissScenario = isExactPreferenceMissing(userQuery);
        if (prefMissScenario && scenarioProducts.length) {
            await sendExactPreferenceMissingMessage();
        }
        return JSON.stringify({ success: true, summary: `Found ${scenarioProducts.length} products for the scenario query and displayed them in the UI.`, totalMatches: scenarioProducts.length });
    }

    const styleMap = {
        office: ['office wear', 'office', 'work', 'corporate', 'meeting', 'formal'],
        formal: ['formal', 'office', 'work', 'corporate'],
        casual: ['casual', 'everyday', 'daily'],
        sandals: ['sandal', 'sandals', 'chappal', 'kolhapuri', 'slip-on'],
        flats: ['flat', 'flats', 'ballet'],
        heels: ['heel', 'heels', 'wedge'],
        sports: ['sport', 'sports', 'running', 'sneaker', 'sneakers']
    };
    let matchedStyles = Object.keys(styleMap).filter(key => styleMap[key].some(w => uq.includes(w)));
    if (excludeHeels) {
        matchedStyles = matchedStyles.filter(s => s !== 'heels');
    }
    if (matchedStyles.length) {
        const textOf = (p) => `${p.name || ''} ${p.category || ''} ${(Array.isArray(p.tags) ? p.tags.join(' ') : '')}`.toLowerCase();
        const hasNeutralColors = (p) => Array.isArray(p.colors) ? p.colors.some(c => /(black|brown|tan|beige|nude)/i.test(String(c))) : false;
        let deterministic = allProducts.filter(p => {
            const t = textOf(p);
            const matchAnyStyle = matchedStyles.some(style => styleMap[style].some(term => t.includes(term)));
            if (matchedStyles.includes('office') || matchedStyles.includes('formal')) {
                const formFactor = /(flat|loafer|pump|ballet|oxford|derby|slip-on|wedge)/.test(t);
                return matchAnyStyle || (formFactor && hasNeutralColors(p));
            }
            return matchAnyStyle;
        });
        if (!deterministic.length && (matchedStyles.includes('office') || matchedStyles.includes('formal'))) {
            deterministic = allProducts.filter(p => {
                const t = textOf(p);
                return /(flat|loafer|ballet|wedge|oxford|derby)/.test(t) || hasNeutralColors(p);
            });
        }
        if (deterministic.length) {
            filteredProducts = deterministic.slice();
            try {
                filteredProducts = ranker.rankProducts(filteredProducts, getUserState(socket.user_id), userQuery || "");
            } catch (e) { }
            const currentState = userStates.get(socket.user_id) || {};
            userStates.set(socket.user_id, { ...currentState, lastSearchResults: filteredProducts, lastQueryProducts: filteredProducts, productViewIndex: 0 });
            const prefMissStyles = isExactPreferenceMissing(userQuery);
            if (prefMissStyles && filteredProducts.length) {
                try {
                    console.log("INTENT_FLOW", {
                        user_id: socket && socket.user_id ? socket.user_id : null,
                        message: String(userQuery || ""),
                        route: "preference_miss_alternative",
                        functionHit: "search_products"
                    });
                } catch (e) { }
                await sendExactPreferenceMissingMessage();
            }
            await show_more_products({}, socket);
            return JSON.stringify({ success: true, summary: `Found ${filteredProducts.length} relevant products for "${userQuery}" and displayed them in the UI.`, totalMatches: filteredProducts.length });
        }
    }

    if (words.length >= 2 && !isNumericOnly && !isGreeting && !isPolicyQuestion) {
        const fuzzyResults = fuzzyMatchProducts(allProducts, userQuery);
        if (fuzzyResults.length > 0) {
            let rankedFuzzy;
            try {
                rankedFuzzy = ranker.rankProducts(fuzzyResults, getUserState(socket.user_id), userQuery || "");
            } catch (e) {
                rankedFuzzy = fuzzyResults;
            }
            const st = userStates.get(socket.user_id) || {};
            userStates.set(socket.user_id, { ...st, lastSearchResults: rankedFuzzy, lastQueryProducts: rankedFuzzy, productViewIndex: 0 });
            const prefMissFuzzy = isExactPreferenceMissing(userQuery);
            if (prefMissFuzzy && rankedFuzzy.length) {
                try {
                    console.log("INTENT_FLOW", {
                        user_id: socket && socket.user_id ? socket.user_id : null,
                        message: String(userQuery || ""),
                        route: "preference_miss_alternative",
                        functionHit: "search_products"
                    });
                } catch (e) { }
                await sendExactPreferenceMissingMessage();
            }
            await show_more_products({}, socket);
            return JSON.stringify({ success: true, summary: `Found ${rankedFuzzy.length} close matches using fuzzy name lookup and displayed them in the UI.`, totalMatches: rankedFuzzy.length });
        }
    }

    const vectorResults = await vectorSearch.semanticSearch(userQuery, 5);
    const productMap = new Map(allProducts.map(p => [String(p.id), p]));
    filteredProducts = vectorResults.map(r => productMap.get(String(r.id))).filter(Boolean);
    filteredProducts = applyConstraints(filteredProducts);

    if (sortBy) {
        filteredProducts.sort((a, b) => {
            if (sortBy === 'price_low_to_high') return a.numericPrice - b.numericPrice;
            if (sortBy === 'price_high_to_low') return b.numericPrice - a.numericPrice;
            return 0;
        });
    }

    try {
        filteredProducts = ranker.rankProducts(filteredProducts, getUserState(socket.user_id), userQuery || "");
    } catch (e) { }
    const currentState = userStates.get(socket.user_id) || {};
    userStates.set(socket.user_id, {
        ...currentState,
        lastSearchResults: filteredProducts,
        lastQueryProducts: filteredProducts,
        productViewIndex: 0
    });

    if (!filteredProducts.length) {
        const recommended = pickCuratedAlternatives(allProductsOriginal);
        if (recommended.length) {
            await sendNoMatchButAlternativesMessage();
            const st = getUserState(socket.user_id);
            st.lastSearchResults = recommended;
            st.lastQueryProducts = recommended;
            st.productViewIndex = 0;
            userStates.set(socket.user_id, st);
            await show_more_products({ catalog_mode: 'replace' }, socket);
            return JSON.stringify({ success: false, summary: "No exact match; displayed curated alternatives in the UI.", totalMatches: recommended.length });
        }
        await sendMessage(socket, `Sorry, ${BRAND_NAME} catalog me is specific concern ke liye abhi koi product nahi mila. Filhaal hum is problem ka direct solution offer nahi kar pa rahe.`, socket.user_id);
        return JSON.stringify({ success: false, summary: "No products found matching the user query.", totalMatches: 0 });
    }

    await show_more_products({}, socket);

    const exactPreferenceMissing = isExactPreferenceMissing(userQuery);
    if (exactPreferenceMissing && filteredProducts.length) {
        try {
            console.log("INTENT_FLOW", {
                user_id: socket && socket.user_id ? socket.user_id : null,
                message: String(userQuery || ""),
                route: "preference_miss_alternative",
                functionHit: "search_products"
            });
        } catch (e) { }
        await sendExactPreferenceMissingMessage();
    }

    return JSON.stringify({
        success: true,
        summary: `Found ${filteredProducts.length} relevant products for the query "${userQuery}" and displayed them in the UI.`,
        totalMatches: filteredProducts.length
    });
}

// yeh function base product/description se semantically milte‑julte products recommend karta hai
async function semanticRecommendation(args) {
    const {
        baseProductId,
        baseDescription,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        vectorSearch,
        show_more_products,
        getRecommendedProductsForProduct
    } = args;

    const products = await getLiveProducts();
    const st = getUserState(socket.user_id);
    let base = null;
    let queryText = '';
    if (baseProductId) {
        base = products.find(p => String(p.id) === String(baseProductId));
    }
    if (!base && st && st.lastDetailedProduct) {
        base = st.lastDetailedProduct;
    }
    if (baseDescription && String(baseDescription).trim()) {
        queryText = String(baseDescription).trim();
    } else if (base) {
        queryText = [base.name, base.description, base.material, Array.isArray(base.tags) ? base.tags.join(' ') : '', base.category].filter(Boolean).join(' ');
    }
    if (base && base.shopifyId) {
        const recommended = await getRecommendedProductsForProduct(base, limit || 5);
        if (recommended && recommended.length) {
            const picksFromRec = recommended.slice(0, limit || 5);
            const stateForRec = getUserState(socket.user_id);
            stateForRec.lastSearchResults = picksFromRec;
            stateForRec.lastQueryProducts = picksFromRec;
            stateForRec.productViewIndex = 0;
            userStates.set(socket.user_id, stateForRec);
            await show_more_products({}, socket);
            return JSON.stringify({
                success: true,
                summary: `Found ${picksFromRec.length} Shopify recommended similar products.`,
                totalMatches: picksFromRec.length
            });
        }
    }
    if (!queryText) {
        return JSON.stringify({ success: false, summary: "No base description or product available for semantic recommendation.", totalMatches: 0 });
    }
    const results = await vectorSearch.semanticSearch(queryText, limit);
    const productMap = new Map(products.map(p => [String(p.id), p]));
    const picks = results.map(r => productMap.get(String(r.id))).filter(Boolean);
    if (!picks.length) {
        return JSON.stringify({ success: false, summary: "No semantically similar products found.", totalMatches: 0 });
    }
    const st2 = getUserState(socket.user_id);
    st2.lastSearchResults = picks;
    st2.lastQueryProducts = picks;
    st2.productViewIndex = 0;
    userStates.set(socket.user_id, st2);
    await show_more_products({}, socket);
    return JSON.stringify({ success: true, summary: `Found ${picks.length} semantically similar products and displayed them in the UI.`, totalMatches: picks.length });
}

// yeh function kisi base product se thoda premium/upgrade wale upsell options dhoondhta hai
async function upsellRecommendation(args) {
    const {
        baseProductId,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        sendMessage,
        ranker,
        show_more_products,
        getRecommendedProductsForProduct
    } = args;

    const products = await getLiveProducts();
    const st = getUserState(socket.user_id);
    let base = null;
    if (baseProductId) {
        base = products.find(p => String(p.id) === String(baseProductId));
    }
    if (!base) {
        base = st.lastDetailedProduct || (Array.isArray(st.lastDisplayedProducts) && st.lastDisplayedProducts.length ? st.lastDisplayedProducts[0] : null);
    }
    if (!base) {
        return JSON.stringify({ success: false, summary: "No base product available for upsell.", totalMatches: 0 });
    }
    const basePrice = Number(base.numericPrice || 0);
    const baseCategory = String(base.category || "").toLowerCase();
    let candidates = [];
    if (base.shopifyId) {
        const recs = await getRecommendedProductsForProduct(base, (limit || 5) * 2);
        if (Array.isArray(recs) && recs.length) {
            candidates = recs.filter(p => {
                if (String(p.id) === String(base.id)) return false;
                const price = Number(p.numericPrice || 0);
                if (!price || price <= basePrice) return false;
                if (baseCategory && String(p.category || "").toLowerCase() !== baseCategory) return false;
                return true;
            });
        }
    }
    if (!candidates.length) {
        candidates = products.filter(p => {
            if (String(p.id) === String(base.id)) return false;
            const price = Number(p.numericPrice || 0);
            if (!price || price <= basePrice) return false;
            if (baseCategory && String(p.category || "").toLowerCase() !== baseCategory) return false;
            return price <= basePrice * 2.2;
        });
    }
    if (!candidates.length) {
        return JSON.stringify({ success: false, summary: "No suitable upsell alternatives found.", totalMatches: 0 });
    }
    let ranked = candidates;
    try {
        ranked = ranker.rankProducts(candidates, st, base.name || "");
    } catch (e) {
        ranked = candidates;
    }
    const picks = ranked.slice(0, limit || 5);
    const heading = `Upgrade options for ${base.name}:`;
    await sendMessage(socket, heading, socket.user_id);
    const nextState = getUserState(socket.user_id);
    nextState.lastSearchResults = picks;
    nextState.lastQueryProducts = picks;
    nextState.productViewIndex = 0;
    userStates.set(socket.user_id, nextState);
    await show_more_products({}, socket);
    return JSON.stringify({
        success: true,
        summary: `Found ${picks.length} upgrade options for ${base.name}.`,
        baseProduct: { id: base.id, name: base.name, price: base.price },
        totalMatches: picks.length
    });
}

// yeh function base product ke saath ache pair hone wale complementary cross‑sell products suggest karta hai
async function crossSellRecommendation(args) {
    const {
        baseProductId,
        limit,
        socket,
        getLiveProducts,
        getUserState,
        userStates,
        sendMessage,
        ranker,
        show_more_products,
        getRecommendedProductsForProduct
    } = args;

    const products = await getLiveProducts();
    const st = getUserState(socket.user_id);
    let base = null;
    if (baseProductId) {
        base = products.find(p => String(p.id) === String(baseProductId));
    }
    if (!base) {
        base = st.lastDetailedProduct || (Array.isArray(st.lastDisplayedProducts) && st.lastDisplayedProducts.length ? st.lastDisplayedProducts[0] : null);
    }
    if (!base) {
        return JSON.stringify({ success: false, summary: "No base product available for cross-sell.", totalMatches: 0 });
    }
    const basePrice = Number(base.numericPrice || 0);
    const baseTags = Array.isArray(base.crossSell) && base.crossSell.length
        ? base.crossSell
        : Array.isArray(base.tags) ? base.tags : [];
    const tagSet = new Set(baseTags.map(t => String(t).toLowerCase()));
    let candidates = [];
    if (base.shopifyId) {
        const recs = await getRecommendedProductsForProduct(base, (limit || 5) * 2);
        if (Array.isArray(recs) && recs.length) {
            candidates = recs.filter(p => String(p.id) !== String(base.id));
        }
    }
    if (!candidates.length) {
        candidates = products.filter(p => {
            if (String(p.id) === String(base.id)) return false;
            const tags = Array.isArray(p.tags) ? p.tags : [];
            const price = Number(p.numericPrice || 0);
            const hasOverlap = tags.some(t => tagSet.has(String(t).toLowerCase()));
            if (!hasOverlap) return false;
            if (basePrice && price > basePrice * 1.4) return false;
            return true;
        });
    }
    if (!candidates.length) {
        return JSON.stringify({ success: false, summary: "No suitable complementary products found.", totalMatches: 0 });
    }
    let ranked = candidates;
    try {
        ranked = ranker.rankProducts(candidates, st, base.name || "");
    } catch (e) {
        ranked = candidates;
    }
    const picks = ranked.slice(0, limit || 5);
    const heading = `Pairs that go well with ${base.name}:`;
    await sendMessage(socket, heading, socket.user_id);
    const nextState = getUserState(socket.user_id);
    nextState.lastSearchResults = picks;
    nextState.lastQueryProducts = picks;
    nextState.productViewIndex = 0;
    userStates.set(socket.user_id, nextState);
    await show_more_products({}, socket);
    return JSON.stringify({
        success: true,
        summary: `Found ${picks.length} products that pair well with ${base.name}.`,
        baseProduct: { id: base.id, name: base.name, price: base.price },
        totalMatches: picks.length
    });
}

// yeh helper user ke message se compare karne ke liye codes/SKUs/naam nikalta hai
function extractCompareHints(text) {
    const raw = String(text || '');
    const codes = raw.match(/\b\d{3,6}\b/g) || [];
    const uniqueCodes = Array.from(new Set(codes.map(String)));
    const skuMatches = raw.match(/\b[A-Z]{1,6}[-\s]?\d{2,6}[A-Z0-9]*\b/ig) || [];
    const uniqueSkus = Array.from(new Set(skuMatches.map(s => String(s).trim())));
    if (uniqueCodes.length >= 2) {
        return [{ type: 'code', value: uniqueCodes[0] }, { type: 'code', value: uniqueCodes[1] }];
    }
    if (uniqueSkus.length >= 2) {
        return [{ type: 'sku', value: uniqueSkus[0] }, { type: 'sku', value: uniqueSkus[1] }];
    }
    if (uniqueCodes.length === 1 && uniqueSkus.length === 1) {
        return [{ type: 'code', value: uniqueCodes[0] }, { type: 'sku', value: uniqueSkus[0] }];
    }
    const betweenMatch = raw.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
    if (betweenMatch) {
        const a = String(betweenMatch[1] || '').trim();
        const b = String(betweenMatch[2] || '').trim();
        if (a.length >= 3 && b.length >= 3) return [{ type: 'name', value: a }, { type: 'name', value: b }];
    }
    const vsMatch = raw.match(/\b(.+?)\s+(?:vs|v\/s|versus)\s+(.+?)(?:[?.!]|$)/i);
    if (vsMatch) {
        const a = String(vsMatch[1] || '').trim();
        const b = String(vsMatch[2] || '').trim();
        if (a.length >= 3 && b.length >= 3) return [{ type: 'name', value: a }, { type: 'name', value: b }];
    }
    return null;
}

// yeh helper extracted hint ko actual product object me map karta hai
function resolveProductFromHint(hint, products, excludeId) {
    if (!hint || !Array.isArray(products) || !products.length) return null;
    const exclude = excludeId != null ? String(excludeId) : null;
    const value = String(hint.value || '').trim();
    const valueLc = value.toLowerCase();
    if (!value) return null;

    const byPredicate = (pred) => {
        for (const p of products) {
            if (!p) continue;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) continue;
            if (pred(p)) return p;
        }
        return null;
    };

    if (hint.type === 'code') {
        const code = value;
        const codeRe = new RegExp(`\\b${code}\\b`);
        const exactByCodes = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const codes = Array.isArray(p.codes) ? p.codes.map(x => String(x)) : [];
            return codes.includes(code);
        });
        if (exactByCodes.length === 1) return exactByCodes[0];
        if (exactByCodes.length > 1) {
            const byNameBoundary = exactByCodes.find(p => codeRe.test(String(p && p.name ? p.name : "")));
            return byNameBoundary || exactByCodes[0];
        }
        const exactByName = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const name = p.name != null ? String(p.name) : "";
            return codeRe.test(name);
        });
        if (exactByName.length === 1) return exactByName[0];
        const exactBySkuBoundary = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x)) : [];
            return skus.some(s => codeRe.test(s));
        });
        if (exactBySkuBoundary.length === 1) return exactBySkuBoundary[0];
        return null;
    }

    if (hint.type === 'sku') {
        const exactSku = byPredicate((p) => {
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x).toLowerCase()) : [];
            return skus.some(s => s === valueLc);
        });
        if (exactSku) return exactSku;
        const partialSkuMatches = products.filter(p => {
            if (!p) return false;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) return false;
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x).toLowerCase()) : [];
            return skus.some(s => s.includes(valueLc));
        });
        if (partialSkuMatches.length === 1) return partialSkuMatches[0];
        return null;
    }

    if (hint.type === 'name') {
        const stop = new Set([
            'model', 'product', 'item', 'sku', 'code',
            'compare', 'comparison', 'vs', 'versus', 'between', 'and', 'aur',
            'which', 'better', 'best', 'kaunsa', 'konsa', 'kounsa', 'farak',
            'price', 'rs', 'rupees', 'mrp', 'discount', 'offer',
            'me', 'mein', 'mai', 'ka', 'ki', 'ke', 'hai', 'kya'
        ]);
        const tokens = valueLc
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3 && !stop.has(t));
        if (!tokens.length) return null;

        let best = null;
        let bestScore = 0;
        for (const p of products) {
            if (!p) continue;
            const id = p.id != null ? String(p.id) : null;
            if (exclude && id && id === exclude) continue;
            const nameLc = p.name != null ? String(p.name).toLowerCase() : "";
            const tagsLc = Array.isArray(p.tags) ? p.tags.map(t => String(t).toLowerCase()).join(' ') : "";
            const skusLc = Array.isArray(p.skus) ? p.skus.map(s => String(s).toLowerCase()).join(' ') : "";
            const codesLc = Array.isArray(p.codes) ? p.codes.map(s => String(s).toLowerCase()).join(' ') : "";
            let score = 0;
            for (const t of tokens) {
                if (nameLc.includes(t)) score += 6;
                if (tagsLc.includes(t)) score += 2;
                if (skusLc.includes(t)) score += 2;
                if (codesLc.includes(t)) score += 2;
            }
            if (score > bestScore) {
                bestScore = score;
                best = p;
            }
        }
        return bestScore >= 6 ? best : null;
    }

    return null;
}

// yeh function user ke choose kiye hue product ke baare me detailed explanation bhejta hai
async function describeSelectedProduct(args) {
    const { selectionText, selectionIndex, productId, userQuestion, socket, getUserState, setUserState, sendMessage } = args;
    const state = getUserState(socket.user_id) || {};
    const rawSelection = selectionText != null ? String(selectionText) : '';
    const questionTextStr = userQuestion != null ? String(userQuestion) : rawSelection;
    const selectionTextStr = rawSelection.trim() ? rawSelection : questionTextStr;
    const lc = selectionTextStr.toLowerCase().trim();
    const lcQuestion = questionTextStr.toLowerCase().trim();
    const refText = lcQuestion || lc;
    const products = Array.isArray(state.lastDisplayedProducts) ? state.lastDisplayedProducts : [];
    if (!products.length) {
        await sendMessage(socket, "I don’t see multiple products right now. Please ask me to show products again.", socket.user_id);
        return JSON.stringify({ success: false, error: "No products to describe." });
    }
    const hasSelectionText = !!selectionTextStr.trim();
    const hasSelectionIndex = selectionIndex != null && Number.isFinite(Number(selectionIndex));
    const hasProductId = productId != null && String(productId).trim() !== '';
    if (!hasSelectionText && !hasSelectionIndex && !hasProductId) {
        await sendMessage(socket, "Kaunsa product? Please product card pe click karo ya exact product code/SKU bhejo.", socket.user_id);
        return JSON.stringify({ success: false, error: "No selection provided." });
    }
    let index = null;
    const idxRaw = selectionIndex != null ? Number(selectionIndex) : null;
    if (Number.isFinite(idxRaw)) {
        const idx = Math.trunc(idxRaw);
        if (idx >= 0 && idx < products.length) index = idx;
    }
    const pid = productId != null ? String(productId).trim() : '';
    if (index == null && pid) {
        for (let i = 0; i < products.length; i++) {
            const prod = products[i];
            if (!prod) continue;
            const id = prod.id != null ? String(prod.id) : '';
            if (id && id === pid) {
                index = i;
                break;
            }
        }
    }
    const indexMap = {
        first: 0,
        '1st': 0,
        pehla: 0,
        pahla: 0,
        pehle: 0,
        pahle: 0,
        phle: 0,
        second: 1,
        '2nd': 1,
        dusra: 1,
        doosra: 1,
        dusre: 1,
        third: 2,
        '3rd': 2,
        teesra: 2,
        tisra: 2
    };
    let codeMatch = null;
    if (index == null) {
        codeMatch = refText.match(/\b(\d{3,6})\b/);
        if (codeMatch) {
            const code = codeMatch[1];
            const codeRe = new RegExp("\\b" + code + "\\b", "i");
            let foundIndex = null;
            for (let i = 0; i < products.length; i++) {
                const prod = products[i];
                if (!prod) continue;
                const codes = Array.isArray(prod.codes) ? prod.codes.map(x => String(x)) : [];
                const skus = Array.isArray(prod.skus) ? prod.skus.map(x => String(x)) : [];
                const tags = Array.isArray(prod.tags) ? prod.tags.map(x => String(x)) : [];
                const name = prod.name != null ? String(prod.name) : "";
                if (codes.includes(code)) {
                    foundIndex = i;
                    break;
                }
                if (skus.some(s => codeRe.test(String(s)))) {
                    foundIndex = i;
                    break;
                }
                if (tags.some(t => codeRe.test(String(t)))) {
                    foundIndex = i;
                    break;
                }
                if (codeRe.test(name)) {
                    foundIndex = i;
                    break;
                }
            }
            index = foundIndex;
        } else {
            const anyOrdinal = refText.match(/\b(first|1st|second|2nd|third|3rd|pehla|pahla|pehle|pahle|phle|dusra|doosra|dusre|teesra|tisra)\b/);
            index = anyOrdinal ? indexMap[anyOrdinal[1]] : null;
            if (!anyOrdinal) {
                const skuLike = refText.match(/\b[A-Z]{1,6}[-\s]?\d{2,6}[A-Z0-9]*\b/i);
                const skuToken = skuLike ? String(skuLike[0]).toLowerCase() : "";
                const stop = new Set([
                    'price', 'pricing', 'rs', 'rupees', 'mrp', 'discount', 'offer', 'offers', 'cost', 'rate',
                    'size', 'sizes', 'fit',
                    'color', 'colour', 'colors', 'colours',
                    'delivery', 'shipping', 'track', 'tracking',
                    'link', 'url', 'website', 'page',
                    'details', 'detail', 'describe', 'description', 'features', 'feature', 'specs', 'spec', 'more', 'about',
                    'tell', 'me', 'please', 'show', 'this', 'that', 'one', 'ka', 'ki', 'ke', 'hai', 'kya', 'kitna', 'kitne',
                    'batao', 'bata', 'do', 'btao', 'samjhao'
                ]);
                const rawTokens = refText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
                const tokens = rawTokens.filter(t => t.length >= 3 && !stop.has(t));
                let bestIndex = 0;
                let bestScore = 0;
                for (let i = 0; i < products.length; i++) {
                    const prod = products[i];
                    if (!prod) continue;
                    const nameLc = prod.name != null ? String(prod.name).toLowerCase() : "";
                    const tagsLc = Array.isArray(prod.tags) ? prod.tags.map(t => String(t).toLowerCase()).join(' ') : "";
                    const codesLc = Array.isArray(prod.codes) ? prod.codes.map(t => String(t).toLowerCase()).join(' ') : "";
                    const skusLc = Array.isArray(prod.skus) ? prod.skus.map(t => String(t).toLowerCase()).join(' ') : "";
                    let score = 0;
                    if (skuToken && skusLc.includes(skuToken)) score += 100;
                    if (nameLc && nameLc.length >= 7 && lc.includes(nameLc)) score += 60;
                    for (const t of tokens) {
                        if (nameLc.includes(t)) score += 6;
                        if (tagsLc.includes(t)) score += 3;
                        if (codesLc.includes(t)) score += 3;
                        if (skusLc.includes(t)) score += 3;
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestIndex = i;
                    }
                }
                index = bestScore >= 6 ? bestIndex : null;
            }
        }
    } else {
        codeMatch = lc.match(/\b(\d{3,6})\b/);
    }

    if (index == null || !products[index]) {
        const lastDetailed = state.lastDetailedProduct;
        if (lastDetailed) {
            const lastId = lastDetailed.id != null ? String(lastDetailed.id) : null;
            if (lastId) {
                for (let i = 0; i < products.length; i++) {
                    const prod = products[i];
                    if (!prod) continue;
                    const id = prod.id != null ? String(prod.id) : null;
                    if (id && id === lastId) {
                        index = i;
                        break;
                    }
                }
            }
        }
        if ((index == null || !products[index]) && products.length === 1) {
            index = 0;
        }
    }

    if (index == null || !products[index]) {
        await sendMessage(socket, "Main exact product identify nahi kar pa raha. Please product card pe click karo, ya exact product code/SKU bhejo, ya products phir se show karwa do.", socket.user_id);
        return JSON.stringify({ success: false, error: "Selected product not identified from current view." });
    }
    const p = products[index];
    const productLink = normalizeProductLink(p.link);
    const cur = getUserState(socket.user_id) || {};
    const viewed = Array.isArray(cur.viewedProducts) ? cur.viewedProducts.slice() : [];
    viewed.push(p);
    while (viewed.length > 20) viewed.shift();
    setUserState(socket.user_id, { ...cur, lastDetailedProduct: p, viewedProducts: viewed });
    const isPriceQuery = /(price|pricing|rs|₹|rupees?|mrp|discount|offer|kitne|kitna|rate)/i.test(lcQuestion);
    const isDeliveryQuery = /(delivery|shipping|kab\s*tak|kb\s*tk|tracking)/i.test(lcQuestion);
    if (isPriceQuery || isDeliveryQuery) {
        const parts = [];
        const codeForText = (codeMatch && codeMatch[1]) ? codeMatch[1] : null;
        const numberMatch = String(selectionText || '').match(/(?:₹\s*|rs\.?\s*)?(\d{3,6})/i);
        const userNumber = numberMatch ? numberMatch[1] : null;
        const hasCurrencyMarker = numberMatch ? /(₹|rs\.?)/i.test(numberMatch[0]) : false;
        const claimedPriceNumber = (hasCurrencyMarker && userNumber && (!codeForText || userNumber !== codeForText)) ? userNumber : null;
        if (p.price) {
            const label = codeForText ? ` (${codeForText})` : '';
            let line;
            if (claimedPriceNumber && !String(p.price).includes(claimedPriceNumber)) {
                line = `Dost, ${p.name}${label} ka actual price ${p.price} hai, ${claimedPriceNumber} nahi.`;
            } else {
                line = `Dost, ${p.name}${label} ka price ${p.price} hai.`;
            }
            parts.push(line);
        }
        if (isDeliveryQuery) {
            parts.push("Delivery aam taur par 1-7 working days leti hai, exact time courier aur location pe depend karta hai. Order ka tracking number milne ke baad aap status check kar sakte hain.");
        }
        const text = parts.join(' ');
        await sendMessage(socket, text, socket.user_id);
        return JSON.stringify({ success: true, answerText: text });
    }
    const aiData = {
        name: p.name,
        price: p.price,
        originalPrice: p.originalPrice,
        isOnSale: !!p.isOnSale,
        sizes: Array.isArray(p.sizes) ? p.sizes.map(s => s.name) : [],
        colors: Array.isArray(p.colors) ? p.colors : [],
        material: p.material || '',
        fit: p.fit || '',
        comfort: p.comfort || '',
        design: p.design || '',
        durability: p.durability || '',
        care: p.care || '',
        link: productLink || '',
        collections: Array.isArray(p.collections) ? p.collections : [],
        rating: typeof p.rating === 'number' ? p.rating : null,
        reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : null,
        description: p.description || '',
        detailsText: p.detailsText || '',
        manufacturingInfo: p.manufacturingInfo || '',
        reviewsText: p.reviewsText || '',
        shippingBadges: Array.isArray(p.shippingBadges) ? p.shippingBadges : []
    };
    const prompt = `The shopper just asked: "${questionTextStr}". Using only the product data I provide, answer their question directly and clearly for this ${BRAND_NAME} product as a friendly shopping assistant.

Focus on information visible in the product data: price, discount, colour, available sizes, fabric/material, fit, comfort, design details, care instructions, delivery badges, rating and reviews, and collection/occasion tags.

First, if the shopper states any specific fact (for example price, size, material, delivery time, discount), compare it with the product data. If they wrote something incorrect, clearly correct it before continuing. Never confirm a wrong detail.

After correcting any mistakes, answer the shopper's question using only the product information you have. If some detail (for example exact price, size availability, fabric, rating, discount, or delivery time) is missing, clearly say you do not know instead of guessing.

If the question is about suitability or styling (for example "office ke liye theek hai?", "summer me pehen sakte hain?", "party wear hai?"), focus on:
- which occasions and weather the product seems suitable for based on description, fabric and design,
- how the fit and material are likely to feel in daily wear,
- simple care and handling tips if care information exists.

When you give any description or explanation for this product, prefer 2–6 short bullet points. Each bullet must be on its own line, start with "- ", and use at most 16 words so that the text does not look crowded. Do not cram multiple sentences inside one bullet.

Only if the shopper explicitly asked for a description/details (e.g., "tell me more", "more about", "details", "describe", "description", "features", "specs", "review", "reviews"), or their question clearly needs explanation, you may add a short product description and benefits, formatted as these bullets. Otherwise, keep the answer minimal and focused on their question. If rating information is provided, mention it clearly as "Rating: X/5". If a link exists, include exactly this HTML snippet: Link: <a href="URL">click here</a>. Write everything in clean plain text without using Markdown formatting like *, **, bullet markers with asterisks, underscores, or markdown-style links. Do not include images.`;
    const messages = [
        { role: 'system', content: prompt },
        { role: 'system', content: JSON.stringify(aiData) }
    ];
    const resp = { success: false };
    const lcSel = lcQuestion;
    const wantsFullDesc = /\b(tell\s+me\s+more|more\s+about|details?|detail|describe|description|features?|specs?|review|reviews|information|info)\b/i.test(lcSel)
        || /\b(iske|is|product)\s+bare\s*me\b/.test(lcSel)
        || /\b(batao|btado|btao)\b/.test(lcSel);
    const wantsPrice = /\b(price|pricing|rs|₹|rupees?|mrp|discount|offer|kitne|kitna|rate)\b/i.test(lcSel);
    const wantsSizes = /\b(size|sizes|available\s+sizes|fit)\b/i.test(lcSel);
    const wantsColors = /\b(color|colour|colors|colours)\b/i.test(lcSel);
    const wantsMaterial = /\b(material|fabric|leather|pu|synthetic)\b/i.test(lcSel);
    const wantsWater = /\b(water\s*proof|waterproof|water\s*resistant|water\s*resistance|paani\s*me\s*kharab|pani\s*me\s*kharab|baarish\s*me|barish\s*me|rain\s*me|in\s*rain|for\s*rain|monsoon)\b/i.test(lcSel);
    const wantsRating = /\b(rating|ratings|review|reviews)\b/i.test(lcSel);
    const wantsLink = /\b(link|url|website|page)\b/i.test(lcSel);
    const wantsAnything = wantsFullDesc || wantsPrice || wantsSizes || wantsColors || wantsMaterial || wantsWater || wantsRating || wantsLink;

    if (!wantsAnything) {
        let text;
        if (codeMatch && codeMatch[1]) {
            const codeForText = codeMatch[1];
            text = `I found a product with code ${codeForText}. Please click the product card for details or ask me if you want more information.`;
        } else {
            text = "I found this product. Please click the product card for details or ask me if you want specific information like price, size, or material.";
        }
        await sendMessage(socket, text, socket.user_id);
        return JSON.stringify({ success: true, answerText: text });
    }

    const fallbackParts = [];
    const hasAnyDescriptionField = !!(p.description || p.detailsText || p.reviewsText || p.manufacturingInfo || p.care || p.design || p.material || p.fit || p.comfort);
    if (wantsFullDesc && !hasAnyDescriptionField) {
        const linkText = productLink && /^https?:\/\//.test(String(productLink))
            ? ` Please product page pe details check karein: <a href="${productLink}">click here</a>.`
            : " Please product page pe details check karein.";
        const msg = `Is product ka detailed description mere paas nahi hai.${linkText}`;
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: true, answerText: msg, noDescription: true });
    }
    if (wantsFullDesc) {
        if (p.material) fallbackParts.push(`Material: ${p.material}`);
        if (p.fit) fallbackParts.push(`Fit: ${p.fit}`);
        if (p.design) fallbackParts.push(`Design: ${p.design}`);
        if (p.durability) fallbackParts.push(`Durability: ${p.durability}`);
        if (p.comfort) fallbackParts.push(`Comfort: ${p.comfort}`);
        if (p.care) fallbackParts.push(`Care Instructions: ${p.care}`);
        if (p.detailsText) fallbackParts.push(`Details: ${p.detailsText}`);
        if (p.manufacturingInfo) fallbackParts.push(`Manufacturing: ${p.manufacturingInfo}`);
        if (p.reviewsText) fallbackParts.push(`Customer Reviews: ${p.reviewsText}`);
        if (Array.isArray(p.shippingBadges) && p.shippingBadges.length) fallbackParts.push(`Shipping/Benefits: ${p.shippingBadges.join(', ')}`);
    } else {
        if (wantsMaterial && p.material) {
            fallbackParts.push(`Material: ${p.material}`);
        }
    }

    if (wantsMaterial && !p.material) {
        fallbackParts.push("Material ke bare me exact information data me available nahi hai.");
    }

    if (wantsWater) {
        const waterTextSource = [
            p.description,
            p.detailsText,
            p.reviewsText,
            Array.isArray(p.tags) ? p.tags.join(' ') : '',
            p.material,
            p.design,
            p.care,
            Array.isArray(p.shippingBadges) ? p.shippingBadges.join(' ') : ''
        ].filter(Boolean).join(' ').toLowerCase();
        const mentionsWaterproof = /\bwater\s*-?\s*proof\b|\bwater\s*-?\s*resistan/i.test(waterTextSource);
        const mentionsRain = /\brain\b|\bbaarish\b|\bbarish\b|\bmonsoon\b/i.test(waterTextSource);
        if (mentionsWaterproof) {
            fallbackParts.push("Water exposure: Description me waterproof ya water-resistant mention hai, baarish me use kar sakte ho.");
        } else if (mentionsRain) {
            fallbackParts.push("Water exposure: Description baarish context mention karta hai, lekin waterproof clearly nahi likha.");
        } else {
            fallbackParts.push("Water exposure: Data me waterproof ya water-resistant info nahi hai, isliye confirm nahi kar sakta.");
        }
    }

    if ((wantsRating || wantsFullDesc) && typeof p.rating === 'number') fallbackParts.push(`Rating: ${p.rating.toFixed(1)}/5`);
    if ((wantsRating || wantsFullDesc) && typeof p.reviewCount === 'number') fallbackParts.push(`Based on ${p.reviewCount} review(s).`);

    if ((wantsSizes || wantsFullDesc) && Array.isArray(p.sizes) && p.sizes.length) {
        fallbackParts.push(`Available Sizes: ${Array.from(new Set(p.sizes.map(s => String(s.name).trim()))).join(', ')}`);
    }
    if ((wantsColors || wantsFullDesc) && Array.isArray(p.colors) && p.colors.length) {
        fallbackParts.push(`Available Colors: ${Array.from(new Set(p.colors.map(c => String(c).trim()))).join(', ')}`);
    }
    if ((wantsPrice || wantsFullDesc || (!wantsSizes && !wantsColors && !wantsMaterial && !wantsRating && !wantsLink)) && p.price) {
        fallbackParts.push(`Price: ${p.price}`);
    }

    const linkLine = ((wantsLink || wantsFullDesc) && productLink && /^https?:\/\//.test(String(productLink))) ? `\nLink: <a href="${productLink}">click here</a>` : '';
    const fallbackText = fallbackParts.length
        ? `Here are the details for ${p.name}:\n- ${fallbackParts.join('\n- ')}${linkLine}`
        : `Here are the details for ${p.name}:${linkLine}`;
    const text = fallbackText;
    const imageUrl = p.imageUrl || (Array.isArray(p.images) && p.images.length ? p.images[0] : null);
    const payload = imageUrl
        ? { type: 'message', data: text, sender: 'bot-message', imageUrl }
        : text;
    await sendMessage(socket, payload, socket.user_id);
    return JSON.stringify({ success: true, answerText: text });
}

// yeh function do recent ya user‑specified products ko side‑by‑side compare karke answer deta hai
async function compareRecentProducts(args) {
    const { userQuestion, socket, getUserState, setUserState, getLiveProducts, sendMessage, safeCallOpenAI } = args;
    const state = getUserState(socket.user_id) || {};
    const viewed = Array.isArray(state.viewedProducts) ? state.viewedProducts : [];
    let p1 = null;
    let p2 = null;
    const hints = extractCompareHints(userQuestion);
    if (hints && hints.length === 2) {
        const allProducts = await getLiveProducts();
        p1 = resolveProductFromHint(hints[0], allProducts, null);
        p2 = resolveProductFromHint(hints[1], allProducts, p1 && p1.id != null ? p1.id : null);
        if (!p1 || !p2) {
            const parts = [];
            const describeHintStatus = (hint, found) => {
                if (!hint) return;
                const raw = hint.value != null ? String(hint.value).trim() : "";
                if (!raw) return;
                const kind = hint.type === 'name' ? 'naam' : 'code/SKU';
                if (found) {
                    parts.push(`"${raw}" (${kind}) ka product mil gaya.`);
                } else {
                    parts.push(`"${raw}" (${kind}) ka product catalog me nahi mila.`);
                }
            };
            describeHintStatus(hints[0], !!p1);
            describeHintStatus(hints[1], !!p2);
            const statusLine = parts.length
                ? parts.join(' ')
                : "Aapke diye hue dono products me se kuch ka match nahi mila.";
            const msg = `${statusLine} Compare karne ke liye dono products ka milna zaroori hai. Jo product missing hai uska exact code/SKU ya website ka link bhej do.`;
            await sendMessage(socket, msg, socket.user_id);
            return JSON.stringify({ success: false, error: "Not enough products to compare.", answerText: msg });
        }
    } else {
        if (viewed.length >= 2) {
            const uniqueRecent = [];
            const seen = new Set();
            for (let i = viewed.length - 1; i >= 0; i--) {
                const p = viewed[i];
                const id = p && p.id != null ? String(p.id) : null;
                if (!id) continue;
                if (seen.has(id)) continue;
                seen.add(id);
                uniqueRecent.push(p);
                if (uniqueRecent.length >= 2) break;
            }
            if (uniqueRecent.length >= 2) {
                p1 = uniqueRecent[1];
                p2 = uniqueRecent[0];
            }
        }
        if (!p1 || !p2) {
            const displayed = Array.isArray(state.lastDisplayedProducts) ? state.lastDisplayedProducts : [];
            if (displayed.length >= 2) {
                p1 = displayed[0];
                p2 = displayed[1];
            }
        }
        if (!p1 || !p2) {
            const recent = Array.isArray(state.recentProductsHistory) ? state.recentProductsHistory : [];
            if (recent.length >= 2) {
                p1 = recent[recent.length - 2];
                p2 = recent[recent.length - 1];
            }
        }
    }
    if (!p1 || !p2) {
        const msg = "Compare karne ke liye kam se kam 2 visible products chahiye. Pehle 2 products show karwa do ya dono ke exact codes/SKUs bhej do.";
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: false, error: "Not enough products to compare.", answerText: msg });
    }
    const cur = getUserState(socket.user_id) || {};
    const viewed2 = Array.isArray(cur.viewedProducts) ? cur.viewedProducts.slice() : [];
    viewed2.push(p1, p2);
    while (viewed2.length > 25) viewed2.shift();
    const displayed2 = Array.isArray(cur.displayedProductsHistory) ? cur.displayedProductsHistory.slice() : [];
    displayed2.push(p1, p2);
    while (displayed2.length > 500) displayed2.shift();
    setUserState(socket.user_id, { ...cur, viewedProducts: viewed2, displayedProductsHistory: displayed2 });
    if (!socket.isWhatsApp) {
        const catalogPayload = {
            type: '__PRODUCT_CATALOG__',
            data: [p1, p2],
            meta: { mode: 'replace' }
        };
        await sendMessage(socket, catalogPayload, socket.user_id);
    }
    const comparisonPrompt = [
        `You are ${BRAND_NAME} shopping and style assistant.`,
        `User message: "${String(userQuestion || "").replace(/\s+/g, " ").trim()}"`,
        "Detect the language and tone from the user message and respond in that same language or mix (Hindi/English/Hinglish).",
        "When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only and do NOT use Devanagari.",
        "Compare Product A vs Product B clearly and fairly. Do not guess missing details; say 'Not specified'.",
        "Constraint: If the user mentions a budget/total, do not recommend above it; if budget is too low, say that clearly.",
        "Output 4–6 very short bullets, each starting with \"- \".",
        "The entire answer must be under 80 words.",
        "Must include: Choose A if..., Choose B if..., comfort/fit, material/durability, style/occasion match, value-for-money, and a final recommendation."
    ].join("\n");
    const comparisonPayload = {
        productA: {
            id: p1.id,
            name: p1.name,
            price: p1.price,
            originalPrice: p1.originalPrice,
            isOnSale: !!p1.isOnSale,
            rating: typeof p1.rating === 'number' ? p1.rating : null,
            reviewCount: typeof p1.reviewCount === 'number' ? p1.reviewCount : null,
            material: p1.material || null,
            fit: p1.fit || null,
            comfort: p1.comfort || null,
            durability: p1.durability || null,
            design: p1.design || null,
            colors: Array.isArray(p1.colors) ? p1.colors : [],
            sizes: Array.isArray(p1.sizes) ? p1.sizes.map(s => s && s.name != null ? String(s.name) : null).filter(Boolean) : [],
            link: normalizeProductLink(p1.link) || null,
            description: p1.description || null
        },
        productB: {
            id: p2.id,
            name: p2.name,
            price: p2.price,
            originalPrice: p2.originalPrice,
            isOnSale: !!p2.isOnSale,
            rating: typeof p2.rating === 'number' ? p2.rating : null,
            reviewCount: typeof p2.reviewCount === 'number' ? p2.reviewCount : null,
            material: p2.material || null,
            fit: p2.fit || null,
            comfort: p2.comfort || null,
            durability: p2.durability || null,
            design: p2.design || null,
            colors: Array.isArray(p2.colors) ? p2.colors : [],
            sizes: Array.isArray(p2.sizes) ? p2.sizes.map(s => s && s.name != null ? String(s.name) : null).filter(Boolean) : [],
            link: normalizeProductLink(p2.link) || null,
            description: p2.description || null
        }
    };
    const ai = await safeCallOpenAI(socket.user_id, [
        { role: "system", content: comparisonPrompt },
        { role: "system", content: JSON.stringify(comparisonPayload) }
    ], false);
    if (ai.success && ai.data?.message?.content) {
        const out = ai.data.message.content;
        await sendMessage(socket, out, socket.user_id);
        return JSON.stringify({ success: true, answerText: out });
    }
    const fallback = "Both are good options; choose based on comfort, durability, and use-case.";
    await sendMessage(socket, fallback, socket.user_id);
    return JSON.stringify({ success: true, fallback: true, answerText: fallback });
}

// yeh function thoda zyada intelligent flow use karke do best possible products pick karke unka comparison karta hai
async function smartCompareProducts(args) {
    const { userQuestion, socket, getUserState, setUserState, getLiveProducts, sendMessage, safeCallOpenAI } = args;
    try {
        const state = getUserState(socket.user_id) || {};
        const viewed = Array.isArray(state.viewedProducts) ? state.viewedProducts : [];
        let p1 = null;
        let p2 = null;
        const hints = extractCompareHints(userQuestion);
        if (hints && hints.length === 2) {
            const allProducts = await getLiveProducts();
            p1 = resolveProductFromHint(hints[0], allProducts, null);
            p2 = resolveProductFromHint(hints[1], allProducts, p1 && p1.id != null ? p1.id : null);
            if (!p1 || !p2) {
                const parts = [];
                const describeHintStatus = (hint, found) => {
                    if (!hint) return;
                    const raw = hint.value != null ? String(hint.value).trim() : "";
                    if (!raw) return;
                    const kind = hint.type === 'name' ? 'naam' : 'code/SKU';
                    if (found) {
                        parts.push(`"${raw}" (${kind}) ka product mil gaya.`);
                    } else {
                        parts.push(`"${raw}" (${kind}) ka product catalog me nahi mila.`);
                    }
                };
                describeHintStatus(hints[0], !!p1);
                describeHintStatus(hints[1], !!p2);
                const statusLine = parts.length
                    ? parts.join(' ')
                    : "Aapke diye hue dono products me se kuch ka match nahi mila.";
                const msg = `${statusLine} Compare karne ke liye dono products ka milna zaroori hai. Jo product missing hai uska exact code/SKU ya website ka link bhej do.`;
                await sendMessage(socket, msg, socket.user_id);
                return JSON.stringify({ success: false, error: "Not enough products to compare.", answerText: msg });
            }
        } else {
            if (viewed.length >= 2) {
                const uniqueRecent = [];
                const seen = new Set();
                for (let i = viewed.length - 1; i >= 0; i--) {
                    const p = viewed[i];
                    const id = p && p.id != null ? String(p.id) : null;
                    if (!id) continue;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    uniqueRecent.push(p);
                    if (uniqueRecent.length >= 2) break;
                }
                if (uniqueRecent.length >= 2) {
                    p1 = uniqueRecent[1];
                    p2 = uniqueRecent[0];
                }
            }

            if (!p1 || !p2) {
                const displayed = Array.isArray(state.lastDisplayedProducts) ? state.lastDisplayedProducts : [];
                if (displayed.length >= 2) {
                    p1 = displayed[0];
                    p2 = displayed[1];
                }
            }

            if (!p1 || !p2) {
                const recent = Array.isArray(state.recentProductsHistory) ? state.recentProductsHistory : [];
                if (recent.length >= 2) {
                    p1 = recent[recent.length - 2];
                    p2 = recent[recent.length - 1];
                }
            }
        }
        
        if (!p1 || !p2) {
            const msg = "Compare karne ke liye kam se kam 2 visible products chahiye. Pehle 2 products show karwa do ya dono ke exact codes/SKUs bhej do.";
            await sendMessage(socket, msg, socket.user_id);
            return JSON.stringify({ success: false, error: "Not enough products to compare.", answerText: msg });
        }
        
        const cur = getUserState(socket.user_id) || {};
        const viewed2 = Array.isArray(cur.viewedProducts) ? cur.viewedProducts.slice() : [];
        viewed2.push(p1, p2);
        while (viewed2.length > 25) viewed2.shift();
        const displayed2 = Array.isArray(cur.displayedProductsHistory) ? cur.displayedProductsHistory.slice() : [];
        displayed2.push(p1, p2);
        while (displayed2.length > 500) displayed2.shift();
        setUserState(socket.user_id, { ...cur, viewedProducts: viewed2, displayedProductsHistory: displayed2 });
        
        if (!socket.isWhatsApp) {
            const catalogPayload = {
                type: '__PRODUCT_CATALOG__',
                data: [p1, p2],
                meta: { mode: 'replace' }
            };
            await sendMessage(socket, catalogPayload, socket.user_id);
        }
        
        const comparisonPrompt = [
            `You are ${BRAND_NAME} shopping and style assistant.`,
            `User message: "${String(userQuestion || "").replace(/\s+/g, " ").trim()}"`,
            "Detect the language and tone from the user message and respond in that same language or mix (Hindi/English/Hinglish).",
            "When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only and do NOT use Devanagari.",
            "Compare Product A vs Product B clearly and fairly. Do not guess missing details; say 'Not specified'.",
            "Constraint: If the user mentions a budget/total, do not recommend above it; if budget is too low, say that clearly.",
            "Output 4–6 very short bullets, each starting with \"- \".",
            "The entire answer must be under 80 words.",
            "Must include: Choose A if..., Choose B if..., comfort/fit, material/durability, style/occasion match, value-for-money, and a final recommendation."
        ].join("\n");
        const comparisonPayload = {
            productA: {
                id: p1.id,
                name: p1.name,
                price: p1.price,
                originalPrice: p1.originalPrice,
                isOnSale: !!p1.isOnSale,
                rating: typeof p1.rating === 'number' ? p1.rating : null,
                reviewCount: typeof p1.reviewCount === 'number' ? p1.reviewCount : null,
                material: p1.material || null,
                fit: p1.fit || null,
                comfort: p1.comfort || null,
                durability: p1.durability || null,
                design: p1.design || null,
                colors: Array.isArray(p1.colors) ? p1.colors : [],
                sizes: Array.isArray(p1.sizes) ? p1.sizes.map(s => s && s.name != null ? String(s.name) : null).filter(Boolean) : [],
                link: normalizeProductLink(p1.link) || null,
                description: p1.description || null
            },
            productB: {
                id: p2.id,
                name: p2.name,
                price: p2.price,
                originalPrice: p2.originalPrice,
                isOnSale: !!p2.isOnSale,
                rating: typeof p2.rating === 'number' ? p2.rating : null,
                reviewCount: typeof p2.reviewCount === 'number' ? p2.reviewCount : null,
                material: p2.material || null,
                fit: p2.fit || null,
                comfort: p2.comfort || null,
                durability: p2.durability || null,
                design: p2.design || null,
                colors: Array.isArray(p2.colors) ? p2.colors : [],
                sizes: Array.isArray(p2.sizes) ? p2.sizes.map(s => s && s.name != null ? String(s.name) : null).filter(Boolean) : [],
                link: normalizeProductLink(p2.link) || null,
                description: p2.description || null
            }
        };
        
        const ai = await safeCallOpenAI(socket.user_id, [
            { role: "system", content: comparisonPrompt },
            { role: "system", content: JSON.stringify(comparisonPayload) }
        ], false);
        if (ai.success && ai.data?.message?.content) {
            let out = ai.data.message.content;
            const words = String(out || "").trim().split(/\s+/).filter(Boolean);
            if (words.length > 80) {
                out = words.slice(0, 80).join(" ");
            }
            await sendMessage(socket, out, socket.user_id);
            return JSON.stringify({ success: true, answerText: out });
        }
        
        const fallback = "Both are good options; choose based on comfort, durability, and use-case.";
        await sendMessage(socket, fallback, socket.user_id);
        return JSON.stringify({ success: true, fallback: true, answerText: fallback });
    } catch (error) {
        console.error("Error in smart_compare_products:", error);
        const msg = "I'm having trouble comparing these products. Please try again.";
        await sendMessage(socket, msg, socket.user_id);
        return JSON.stringify({ success: false, error: "Comparison failed.", answerText: msg });
    }
}

// yeh helper user ke query words se naam ke basis par fuzzy matching karta hai
function fuzzyMatchProducts(products, userQuery, threshold = 0.45) {
    const q = String(userQuery || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = products.map(p => {
        const titleWords = String(p.name || "").toLowerCase().split(/\s+/);
        let matchCount = 0;
        for (const w of q) {
            if (titleWords.some(t => t.includes(w))) matchCount++;
        }
        const score = q.length ? (matchCount / q.length) : 0;
        return { product: p, score };
    });
    const filtered = scored
        .filter(s => s.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map(s => s.product);
    return filtered.slice(0, 3);
}

// yeh helper product name aur user query ko clean karke direct name matching ke liye normalize karta hai
function normalizeForDirectNameMatch(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/\(\s*\d{3,6}\s*\)/g, "")
        .replace(/\d{3,6}/g, "")
        .replace(/[^a-z]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// yeh helper normalized name ke basis par almost exact product name matches dhoondhta hai
function findDirectNameMatches(products, userQuery) {
    const qNorm = normalizeForDirectNameMatch(userQuery);
    if (!qNorm) return [];
    const qWords = qNorm.split(" ");
    if (qWords.length < 3) return [];
    const matches = [];
    for (const p of products) {
        const nameNorm = normalizeForDirectNameMatch(p.name);
        if (!nameNorm) continue;
        const nameWords = nameNorm.split(" ");
        const overlap = qWords.filter(w => nameWords.includes(w));
        const minWords = Math.min(qWords.length, nameWords.length);
        if (overlap.length >= Math.max(1, minWords - 1)) {
            matches.push(p);
        }
    }
    return matches;
}

module.exports = {
    searchProducts,
    semanticRecommendation,
    upsellRecommendation,
    crossSellRecommendation,
    describeSelectedProduct,
    compareRecentProducts,
    smartCompareProducts
};
