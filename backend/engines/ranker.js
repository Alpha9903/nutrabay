function tokenize(s) {
    return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function textForProduct(p) {
    const parts = [
        p.name || "",
        Array.isArray(p.tags) ? p.tags.join(" ") : "",
        p.category || "",
        p.description || ""
    ].join(" ");
    return parts;
}

function parseBudget(b) {
    const m = String(b || "").match(/(\d{3,7})/);
    return m ? parseInt(m[1], 10) : null;
}

function inRecent(userState, p) {
    const list = Array.isArray(userState?.recentProductsHistory) ? userState.recentProductsHistory : [];
    const pid = String(p.id);
    return list.some(x => String(x.id) === pid);
}

function hasSize(p, size) {
    if (!size) return false;
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    return sizes.some(s => String(s.name || s).toLowerCase() === String(size).toLowerCase());
}

function hasColorMatch(p, colors) {
    if (!Array.isArray(colors) || !colors.length) return 0;
    const prodColors = Array.isArray(p.colors) ? p.colors.map(c => String(c).toLowerCase()) : [];
    const set = new Set(prodColors);
    let matches = 0;
    for (const c of colors) if (set.has(String(c).toLowerCase())) matches++;
    const score = Math.min(1, matches / Math.max(1, colors.length));
    return score;
}

function materialMatchPref(prefMaterial, p) {
    if (!prefMaterial) return 0;
    const pm = String(p.material || "").toLowerCase();
    return pm.includes(String(prefMaterial).toLowerCase()) ? 1 : 0;
}

function jaccardSemantic(query, p) {
    const qTokensArr = tokenize(query);
    const pTokensArr = tokenize(textForProduct(p));
    const qTokens = new Set(qTokensArr);
    const pTokens = new Set(pTokensArr);
    if (qTokens.size === 0 && pTokens.size === 0) return 0;
    let inter = 0;
    for (const t of qTokens) if (pTokens.has(t)) inter++;
    const union = new Set([...qTokens, ...pTokens]).size;
    return union ? (inter / union) : 0;
}

function numericPrice(p) {
    const priceStr = p.price || "";
    const np = typeof p.numericPrice === "number" ? p.numericPrice : (parseInt(String(priceStr).replace(/[^0-9]/g, ""), 10) || 0);
    return np || 0;
}

function heelMatch(preferences, query, p) {
    const pref = String(preferences?.heelHeight || "").toLowerCase();
    const q = tokenize(query);
    const shapes = ["heel","heels","high-heel","high","low","flat","wedge","platform"];
    const prodText = tokenize(textForProduct(p));
    const prefMatch = pref ? prodText.includes(pref) || shapes.some(s => pref.includes(s) && prodText.includes(s)) : false;
    const queryMatch = shapes.some(s => q.includes(s) && prodText.includes(s));
    return (prefMatch || queryMatch) ? 1 : 0;
}

function categoryMatch(preferences, query, p) {
    const desired = String(preferences?.category || "").toLowerCase();
    const q = tokenize(query);
    const categories = ["office","formal","casual","party","sport","sports","running","sneaker","sneakers"];
    const prodText = tokenize(textForProduct(p));
    const fromPref = desired ? (prodText.includes(desired) || (Array.isArray(p.tags) && p.tags.some(t => String(t).toLowerCase().includes(desired)))) : false;
    const fromQuery = categories.some(c => q.includes(c) && (prodText.includes(c) || (Array.isArray(p.tags) && p.tags.some(t => String(t).toLowerCase().includes(c)))));
    return (fromPref || fromQuery) ? 1 : 0;
}

function tagOverlapScore(p, query) {
    const tags = Array.isArray(p.tags) ? p.tags.map(t => String(t).toLowerCase()) : [];
    const qTokens = tokenize(query);
    if (!tags.length || !qTokens.length) return 0;
    const setTags = new Set(tags);
    let inter = 0;
    for (const t of qTokens) if (setTags.has(t)) inter++;
    const union = new Set([...setTags, ...qTokens]).size;
    return union ? inter / union : 0;
}

function silhouetteMatch(preferences, query, p) {
    const descriptors = ["loafer","sneaker","pump","ballet","oxford","derby","wedge","flat","boot","sandal","mule","clog"];
    const prefDesc = String(preferences?.shape || "").toLowerCase();
    const qTokens = new Set(tokenize(query));
    const prodTokens = new Set(tokenize(textForProduct(p)));
    const prefHit = descriptors.some(d => prefDesc.includes(d) && prodTokens.has(d));
    const queryHit = descriptors.some(d => qTokens.has(d) && prodTokens.has(d));
    return (prefHit || queryHit) ? 1 : 0;
}

function rankProducts(products, userState, query) {
    if (!Array.isArray(products) || products.length === 0) return products;
    const prefs = userState?.preferences || {};
    const budget = parseBudget(prefs?.budget);
    const colors = prefs?.colors || [];
    const size = prefs?.size || null;
    const materialPref = prefs?.material || "";
    let minPrice = Infinity;
    let maxPrice = 0;
    const prices = products.map(numericPrice);
    for (const np of prices) {
        if (np > maxPrice) maxPrice = np;
        if (np < minPrice) minPrice = np;
    }
    const ranked = products.map(p => {
        const semanticScore = jaccardSemantic(query, p);
        const preferenceScore =
            0.4 * materialMatchPref(materialPref, p) +
            0.3 * Math.min(1, hasColorMatch(p, colors)) +
            0.2 * (hasSize(p, size) ? 1 : 0) +
            0.1 * heelMatch(prefs, query, p);
        const metaCategory = categoryMatch(prefs, query, p) ? 0.3 : 0;
        const metaTags = 0.2 * tagOverlapScore(p, query);
        const metaSilhouette = silhouetteMatch(prefs, query, p) ? 0.2 : 0;
        const metadataScore = metaCategory + metaTags + metaSilhouette;
        const np = numericPrice(p);
        let priceScore = 0;
        if (budget) {
            if (np && np <= budget) priceScore = 0.3;
            else if (np && np <= Math.floor(budget * 1.15)) priceScore = 0.15;
            else priceScore = 0;
        } else {
            if (isFinite(minPrice) && isFinite(maxPrice) && maxPrice > minPrice) {
                const norm = (np - minPrice) / (maxPrice - minPrice);
                priceScore = 0.15 * (1 - Math.max(0, Math.min(1, norm)));
            } else {
                priceScore = 0.05;
            }
        }
        const recencyScore = inRecent(userState, p) ? 0.1 : 0;
        const finalScore = 0.30 * semanticScore + 0.30 * preferenceScore + 0.20 * metadataScore + 0.10 * priceScore + 0.10 * recencyScore;
        return { p, score: finalScore };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked.map(r => {
        r.p.__rank_score = r.score;
        return r.p;
    });
}

module.exports = { rankProducts };
