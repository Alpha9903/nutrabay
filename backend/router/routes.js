const botConfig = require('../config/bot_prompts');
const companyConfig = botConfig.company;

// createSearchRouter: Handles product search and "show more" flows, routes to search_products/show_more_products tools
function createSearchRouter(deps) {
    const { getUserState, setUserState, search_products, show_more_products, sendMessage } = deps;
    function shouldHandle(lc) {
        const text = String(lc || '').trim();
        if (!text) return false;
        if (/^\s*(show(\s+me)?(\s+some)?\s+(products?|shoes?|items?|options?)|products?\s+dikha(?:o|ao)?|shoes?\s+dikha(?:o|ao)?)\s*$/.test(text)) return true;
        if (/\b(show\s+(me\s+)?more|show\s+more|more\s+(products?|shoes?|items?|options?)|next\s+(products?|shoes?|items?|options?)|aur\s+dikha(?:o|ao)?|aur\s+(products?|shoes?|options?)\s+dikha(?:o|ao)?)\b/.test(text)) return true;
        if (/\b(show|dikha(?:o|ao)?|dikhado|dikhana|bata(?:o|do)|suggest|recommend)\b.*\b(products?|shoes?|items?|options?)\b/.test(text)) return true;
        if (/\b(products?|shoes?|items?|options?)\b.*\b(show|dikha(?:o|ao)?|dikhado|dikhana)\b/.test(text)) return true;
        const hasProductWord = /\b(shoes?|sneakers?|heels?|sandals?|flats?|loafer|loafers?|boots?|chappal|slippers?|flip\s*flops?)\b/i.test(text);
        const hasBuyingSignal = /\b(chahiye|chahie|chahye|need|want|looking\s+for|kharidna|kharidni|buy|purchase)\b/i.test(text);
        if (hasProductWord && hasBuyingSignal) return true;
        return false;
    }
    async function handle(socket, message, user_id) {
        const lc = String(message || '').toLowerCase().trim();
        const state = getUserState(user_id) || {};
        const hasPreference = /(office|formal|casual|party|wedding|sports?|sport|running|run\b|gym|walk|walking|daily|rozana|roz|sneakers?|loafer|loafers?|heels?|boots?|sandals?|chappal|slippers?|flip\s*flops?|kids|kid|men|man|women|woman|ladies|gents|black|white|brown|red|blue|green|size|rs|₹|under|between|budget|discount|off\b|rating|comfortable|comfort|pain|wide|narrow)/i.test(lc) ||
            /\b\d{1,2}\b/.test(lc);
        const wantsBrowse = shouldHandle(lc);
        const buildQueryFromPreference = (preferenceText, originalQuery) => {
            const pref = String(preferenceText || '').trim();
            const prefLc = pref.toLowerCase();
            const prefHasFootwearWord = /\b(shoe|shoes|footwear|sneaker|sneakers|loafer|loafers|sandal|sandals|chappal|heel|heels|boot|boots|slipper|slippers)\b/.test(prefLc);
            const suffix = prefHasFootwearWord ? '' : ' shoes';
            const oq = String(originalQuery || '').trim();
            const oqLc = oq.toLowerCase();
            const oqUseful = oq && !/^\s*(show(\s+me)?(\s+some)?\s+(products?|shoes?|items?|options?)|apne\s+products?\s+dikha(?:o|ao)?|products?\s+dikha(?:o|ao)?|shoes?\s+dikha(?:o|ao)?)\s*$/.test(oqLc);
            return oqUseful ? `${pref}${suffix} ${oq}`.trim() : `${pref}${suffix}`.trim();
        };

        if (state.searchPrefFlow && state.searchPrefFlow.active && state.searchPrefFlow.step === 'occasion') {
            const preferenceRaw = String(message || '').trim();
            const preferenceLc = preferenceRaw.toLowerCase();
            const pureBrowse = /^\s*(show(\s+me)?(\s+some)?\s+(products?|shoes?|items?|options?)|apne\s+products?\s+dikha(?:o|ao)?|products?\s+dikha(?:o|ao)?|shoes?\s+dikha(?:o|ao)?)\s*$/.test(preferenceLc);
            if (!preferenceRaw || pureBrowse) {
                await sendMessage(socket, "Aap office wear, casual, party, sports ya koi specific type bata do.", user_id);
                return;
            }
            const originalQuery = state.searchPrefFlow.originalQuery || "";
            state.searchPrefFlow = undefined;
            setUserState(user_id, state);
            const userQuery = buildQueryFromPreference(preferenceRaw, originalQuery);
            await search_products({ userQuery }, socket);
            return;
        }

        const isShowMoreOnly = /\b(show\s+(me\s+)?more|show\s+more|more\s+(products?|shoes?|items?|options?)|next\s+(products?|shoes?|items?|options?)|aur\s+dikha(?:o|ao)?|aur\s+(products?|shoes?|options?)\s+dikha(?:o|ao)?)\b/.test(lc) || lc === 'show more products' || lc === 'show more';
        if (isShowMoreOnly) {
            if (Array.isArray(state.lastSearchResults) && state.lastSearchResults.length) {
                await show_more_products({}, socket);
                return;
            }
        }
        if (wantsBrowse && !hasPreference && !isShowMoreOnly) {
            state.searchPrefFlow = { active: true, step: 'occasion', originalQuery: String(message || '') };
            setUserState(user_id, state);
            await sendMessage(socket, "Aap kis type ke shoes dekhna chahte ho: office wear, casual, party, sports, ya kuch aur?");
            return;
        }
        await search_products({ userQuery: message }, socket);
    }
    return { shouldHandle, handle };
}

// createOrdinalRouter: Handles "first/second/ye wala" style references to currently shown products
function createOrdinalRouter(deps) {
    const { getUserState, setUserState, show_more_products, callOpenAI, sendMessage } = deps;
    function shouldHandle(state, lc) {
        if (!lc) return false;
        if (/(compare|comparison|difference|diff\b|farak|fark|farq|frk|antar|between\b|vs\b|which\s+is\s+better|which\s+one\s+is\s+better|which\s+product\s+is\s+best|better\s+for|best\s+for|kaunsa\s+better|kaun\s+sa\b)/.test(lc)) {
            return false;
        }
        const directOrdinalMatch = lc.match(/\b(this|that|yeh?|is|us)\s+(first|1st|second|2nd|third|3rd|left|middle|right)\s+(one|item|product|wala|wale|wali)\b/);
        const anyOrdinal = lc.match(/\b(first|1st|second|2nd|third|3rd|left|middle|right)\b/);
        const hindiOrdinal = lc.match(/\b(pehla|pahla|pehle|pahle|phle|dusra|dusri|doosra|doosri|dusre|teesra|tisra)\b/);
        const hindiThisThat = /(yeh?|ye|is|us)\s+(\w+\s+)?(wala|wale|wali)\b/.test(lc);
        const hindiOther = /(dusra|dusri|doosra|doosri|dusre)\s+(\w+\s+)?(wala|wale|wali)\b/.test(lc);
        const refersToCurrentProducts = /(this|that|yeh?|ye|is|us)\s+(\w+\s+)?(one|item|product|wala|wale|wali)|tell me(\s+\w+)*\s+about\s+(this|that|yeh?|ye|is|us)|\b(is|yeh?|ye|us)\s+(ke?\s+)?ba(re|are)\s+me\b/.test(lc);
        const devOrdinal = /(?:^|[\s,.;!?])(?:पहला|पहले|दूसरा|दूसरे|तीसरा|तीसरे|प्रथम|द्वितीय|तृतीय|फर्स्ट|सेकंड|सैकंड|थर्ड|2nd|3rd|1st)(?:$|[\s,.;!?])/i.test(lc);
        const devWala = /(वाला|वाले|वाली)\b/i.test(lc);
        const devAbout = /(के\s+बारे\s+में|के\s+बारे\s+मे|बारे\s+में|बारे\s+मे)/i.test(lc);
        const hasProducts = Array.isArray(state && state.lastDisplayedProducts) && state.lastDisplayedProducts.length > 0;
        return hasProducts && (!!directOrdinalMatch || !!anyOrdinal || !!hindiOrdinal || hindiThisThat || hindiOther || refersToCurrentProducts || devOrdinal || (devWala && devAbout));
    }
    async function handle(socket, message, user_id) {
        const lc = String(message || '').toLowerCase().trim();
        const indexMap = {
            first: 0,
            '1st': 0,
            '1': 0,
            pehla: 0,
            pahla: 0,
            pehle: 0,
            pahle: 0,
            phle: 0,
            पहला: 0,
            पहले: 0,
            प्रथम: 0,
            फर्स्ट: 0,
            second: 1,
            '2nd': 1,
            '2': 1,
            dusra: 1,
            dusri: 1,
            doosra: 1,
            doosri: 1,
            dusre: 1,
            दूसरा: 1,
            दूसरे: 1,
            द्वितीय: 1,
            सेकंड: 1,
            सैकंड: 1,
            third: 2,
            '3rd': 2,
            '3': 2,
            teesra: 2,
            tisra: 2,
            तीसरा: 2,
            तीसरे: 2,
            तृतीय: 2,
            थर्ड: 2
        };
        const anyOrdinal = lc.match(/\b(first|1st|1|second|2nd|2|third|3rd|3|pehla|pahla|pehle|pahle|phle|dusra|dusri|doosra|doosri|dusre|teesra|tisra|f\s*irst|sec\s*ond|thi\s*rd)\b|(?:पहला|पहले|दूसरा|दूसरे|तीसरा|तीसरे|प्रथम|द्वितीय|तृतीय|फर्स्ट|सेकंड|सैकंड|थर्ड)/i);
        const state = getUserState(user_id) || {};
        const products = state.lastDisplayedProducts;
        if (!Array.isArray(products) || products.length === 0) {
            await sendMessage(socket, "I don’t see multiple products right now. Please ask me to show products again.", user_id);
            return;
        }
        const token = anyOrdinal ? (anyOrdinal[1] || anyOrdinal[0]) : null;
        const index = token ? indexMap[token] : 0;
        if (index === undefined || !products[index]) {
            await sendMessage(socket, "That product is not visible right now. Please ask me to show products again.", user_id);
            return;
        }
        const p = products[index];
        const cur = getUserState(socket.user_id) || {};
        const viewed = Array.isArray(cur.viewedProducts) ? cur.viewedProducts.slice() : [];
        viewed.push(p);
        while (viewed.length > 20) viewed.shift();
        setUserState(socket.user_id, { ...cur, lastDetailedProduct: p, viewedProducts: viewed });
        const fallbackParts = [];
        if (p.material) fallbackParts.push(`Material: ${p.material}`);
        if (p.fit) fallbackParts.push(`Fit: ${p.fit}`);
        if (p.design) fallbackParts.push(`Design: ${p.design}`);
        if (p.durability) fallbackParts.push(`Durability: ${p.durability}`);
        if (p.comfort) fallbackParts.push(`Comfort: ${p.comfort}`);
        if (p.care) fallbackParts.push(`Care Instructions: ${p.care}`);
        if (typeof p.rating === 'number') fallbackParts.push(`Rating: ${p.rating.toFixed(1)}/5`);
        if (Array.isArray(p.sizes) && p.sizes.length) fallbackParts.push(`Available Sizes: ${Array.from(new Set(p.sizes.map(s => String(s.name).trim()))).join(', ')}`);
        if (Array.isArray(p.colors) && p.colors.length) fallbackParts.push(`Available Colors: ${Array.from(new Set(p.colors.map(c => String(c).trim()))).join(', ')}`);
        if (p.price) fallbackParts.push(`Price: ${p.price}`);
        const linkLine = (p.link && /^https?:\/\//.test(String(p.link))) ? `\nLink: <a href="${p.link}">click here</a>` : '';
        const fallbackText = `Here are the details for ${p.name}:\n- ${fallbackParts.join('\n- ')}${linkLine}`;
        const text = fallbackText;
        const imageUrl = p.imageUrl || (Array.isArray(p.images) && p.images.length ? p.images[0] : null);
        const payload = imageUrl
            ? { type: 'message', data: text, sender: 'bot-message', imageUrl }
            : text;
        await sendMessage(socket, payload, user_id);
        return;
    }
    return { shouldHandle, handle };
}

// createCompareRouter: Handles explicit comparison intent and routes through callOpenAI for comparison text
function createCompareRouter(deps) {
    const { getUserState, callOpenAI, sendMessage, getLiveProducts } = deps;

    function getPrimaryProductFromState(state) {
        if (!state || typeof state !== 'object') return null;
        if (state.lastDetailedProduct) return state.lastDetailedProduct;
        const displayed = Array.isArray(state.lastDisplayedProducts) ? state.lastDisplayedProducts : [];
        if (displayed[0]) return displayed[0];
        const lastResults = Array.isArray(state.lastSearchResults) ? state.lastSearchResults : [];
        if (lastResults[0]) return lastResults[0];
        const recent = Array.isArray(state.recentProductsHistory) ? state.recentProductsHistory : [];
        if (recent.length) return recent[recent.length - 1];
        return null;
    }

    function findProductByCode(products, code, excludeId = null) {
        if (!code) return null;
        const c = String(code).trim();
        if (!c) return null;
        const exclude = excludeId != null ? String(excludeId) : null;
        for (const p of products || []) {
            if (!p) continue;
            const pid = p.id != null ? String(p.id) : null;
            if (exclude && pid && pid === exclude) continue;
            const codes = Array.isArray(p.codes) ? p.codes.map(x => String(x)) : [];
            const skus = Array.isArray(p.skus) ? p.skus.map(x => String(x)) : [];
            const tags = Array.isArray(p.tags) ? p.tags.map(x => String(x)) : [];
            const name = p.name != null ? String(p.name) : "";
            if (codes.includes(c)) return p;
            if (skus.some(s => s.includes(c))) return p;
            if (tags.some(t => t.includes(c))) return p;
            if (name.includes(c)) return p;
        }
        return null;
    }

    function extractCodesFromText(text) {
        const matches = String(text || '').match(/\b\d{3,6}\b/g);
        if (!matches) return [];
        const seen = new Set();
        const out = [];
        for (const m of matches) {
            const v = String(m);
            if (seen.has(v)) continue;
            seen.add(v);
            out.push(v);
            if (out.length >= 2) break;
        }
        return out;
    }
    function shouldHandle(state, lc) {
        if (!lc) return false;
        const viewed = state && Array.isArray(state.viewedProducts) ? state.viewedProducts : [];
        const hasViewedTwo = viewed.length >= 2;
        const hasTwoDisplayed = state && Array.isArray(state.lastDisplayedProducts) && state.lastDisplayedProducts.length >= 2;
        const hasRecentTwo = state && Array.isArray(state.recentProductsHistory) && state.recentProductsHistory.length >= 2;
        const compareIntent = /(compare|comparison|kyu\s+nahi|why\s+not|difference|diff\b|farak|fark|farq|frk|antar|better\s+for|best\s+for|kaunsa\s+better|kaun\s+sa|kaunse|konsa|kon\s+sa|which\s+one|which\s+should\s+i\s+buy|which\s+should\s+i\s+choose|kis\s+ko\s+lu|kis\s+ko\s+loon|kaun\s+sa\s+lu|kaun\s+sa\s+loon|between\b|vs\b|versus\b|both\s+of\s+them|these\s+two)/i.test(lc);
        if (!compareIntent) return false;
        if (hasViewedTwo || hasTwoDisplayed || hasRecentTwo) return true;
        const hasOneVisible = !!getPrimaryProductFromState(state);
        const codes = extractCodesFromText(lc);
        return hasOneVisible && codes.length > 0;
    }
    async function handle(socket, message, user_id) {
        const state = getUserState(user_id) || {};
        let p1 = null;
        let p2 = null;
        const codes = extractCodesFromText(message);
        if (typeof getLiveProducts === 'function' && codes.length > 0) {
            const primary = getPrimaryProductFromState(state);
            let allProducts = [];
            try {
                allProducts = await getLiveProducts();
            } catch (e) {
                allProducts = [];
            }
            if (codes.length >= 2) {
                const a = findProductByCode(allProducts, codes[0]);
                const b = findProductByCode(allProducts, codes[1], a && a.id != null ? String(a.id) : null);
                if (a && b) {
                    p1 = a;
                    p2 = b;
                } else {
                    await sendMessage(socket, `I couldn’t find both products for codes ${codes.join(" and ")}. Please double-check the codes.`, user_id);
                    return;
                }
            } else if (codes.length === 1 && primary) {
                const other = findProductByCode(allProducts, codes[0], primary && primary.id != null ? String(primary.id) : null);
                if (other) {
                    p1 = primary;
                    p2 = other;
                } else {
                    await sendMessage(socket, `I couldn’t find a product matching code ${codes[0]}. Please double-check the SKU/code.`, user_id);
                    return;
                }
            }
        }
        if (!p1 || !p2) {
            const viewed = Array.isArray(state.viewedProducts) ? state.viewedProducts : [];
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
        if (p1 && p2) {
            const catalogPayload = {
                type: '__PRODUCT_CATALOG__',
                data: [p1, p2],
                meta: { mode: 'replace' }
            };
            await sendMessage(socket, catalogPayload, user_id);
            const clip = (v, maxLen) => {
                const s = String(v || "").replace(/\s+/g, " ").trim();
                const n = Number.isFinite(maxLen) && maxLen > 40 ? Math.floor(maxLen) : 220;
                if (!s) return "";
                return s.length > n ? `${s.slice(0, n)}…` : s;
            };
            const assistantName = companyConfig.chatbot_name || companyConfig.company_name || "shopping assistant";
            const comparison = [
                `You are ${assistantName} shopping and support assistant.`,
                `User message: "${clip(message, 220)}"`,
                "Detect the language and tone from the user message and respond in that same language or mix (Hindi/English/Hinglish).",
                "When the detected language is Hindi or Hinglish, write Hindi using English/Latin alphabets only and do NOT use Devanagari.",
                "Constraint: If the user mentions a budget/total, do not recommend above it; if budget is too low, say that clearly.",
                "Compare Product A vs Product B clearly and fairly. Do not guess missing details; say 'Not specified'.",
                "Output exactly 6–9 short bullets, each starting with \"- \".",
                "Must include: Choose A if..., Choose B if..., comfort/fit, material/durability, style/occasion match, value-for-money, and a final recommendation."
            ].join("\n");
            const aiPayload = {
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
                    link: p1.link || null
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
                    link: p2.link || null
                }
            };
            const ai = await callOpenAI([
                { role: "system", content: comparison },
                { role: "system", content: JSON.stringify(aiPayload) }
            ]);
            if (ai.success && ai.data?.message?.content) {
                await sendMessage(socket, ai.data.message.content, user_id);
            } else {
                await sendMessage(socket, "Both are good options; choose based on comfort, durability, and use-case.", user_id);
            }
            return;
        }
    }
    return { shouldHandle, handle };
}

// createAdminRouter: Handles "admin mode" flow and routes to admin_mode tool for dashboard
function createAdminRouter(deps) {
    const { getUserState, setUserState, deleteUserState, admin_mode, sendMessage } = deps;
    function shouldHandle(state, lc) {
        if (lc === 'admin mode') return true;
        if (state && state.mode === 'awaiting_admin_password') return true;
        return false;
    }
    async function handle(socket, message, user_id) {
        const lc = String(message || '').toLowerCase().trim();
        if (lc === 'admin mode') {
            const st = getUserState(user_id);
            st.mode = 'awaiting_admin_password';
            setUserState(user_id, st);
            await sendMessage(socket, "Please enter the administrative password.", user_id);
            return;
        }
        if (getUserState(user_id).mode === 'awaiting_admin_password') {
            const functionResponse = await admin_mode({ command: 'check_password', value: message }, socket);
            const toolResult = JSON.parse(functionResponse);
            if (toolResult.success) {
                const st = getUserState(user_id);
                st.mode = 'admin';
                setUserState(user_id, st);
                await sendMessage(socket, "Access granted. Welcome.", user_id);
                await sendMessage(socket, { type: '__ADMIN_DASHBOARD__', data: toolResult.data }, user_id);
            } else {
                deleteUserState(user_id);
                await sendMessage(socket, "Access denied. Incorrect password.", user_id);
            }
            return;
        }
    }
    return { shouldHandle, handle };
}

// createSimilarRouter: Handles "similar to this/first one" queries and routes to semantic_recommendation tool
function createSimilarRouter(deps) {
    const { getUserState, semantic_recommendation } = deps;
    function shouldHandle(state, lc) {
        if (!lc) return false;
        return /(something\s+like|similar\s+to|similiar\s+to|something\s+similar\s+to|something\s+similiar\s+to|similar\s+products?|similiar\s+products?|similar\s+ones?|similar\s+pairs?|similar\s+styles?|similiar\s+styles?|show\s+me\s+similar|show\s+similar\s+products?|similar\s+to\s+the\s+(first|second|third)|like\s+the\s+(first|second|third))/i.test(lc);
    }
    async function handle(socket, message, user_id) {
        const lc = String(message || '').toLowerCase().trim();
        const ordinalWordToIndex = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 };
        const anyOrdinal = lc.match(/\b(first|1st|second|2nd|third|3rd)\b/);
        let idx = anyOrdinal ? ordinalWordToIndex[anyOrdinal[1]] : null;
        const st = getUserState(user_id);
        let base = null;
        if (idx !== null && Array.isArray(st.lastDisplayedProducts) && st.lastDisplayedProducts[idx]) {
            base = st.lastDisplayedProducts[idx];
        } else {
            base = st.lastDetailedProduct || (Array.isArray(st.lastDisplayedProducts) ? st.lastDisplayedProducts[0] : null);
        }
        const desc = base ? [base.name, base.description, base.material, Array.isArray(base.tags) ? base.tags.join(' ') : '', base.category].filter(Boolean).join(' ') : message;
        const baseId = base && base.id ? base.id : null;
        await semantic_recommendation({ baseProductId: baseId, baseDescription: desc, limit: 6 }, socket);
    }
    return { shouldHandle, handle };
}

// createTicketRouter: Drives multi-step ticket raising flow and routes to issue/ticket tools
function createTicketRouter({ getUserState, setUserState, sendMessage, raise_support_ticket }) {
    const intentRegex = /\b(raise|open|create)\s+(a\s+)?(support\s+)?ticket\b|\bticket\s+(raise|open|create)\b/i;

    const shouldHandle = (state, lc) => {
        const active = state && state.ticketFlow && state.ticketFlow.active;
        return active || intentRegex.test(String(lc || ''));
    };

    const handle = async (socket, message, user_id) => {
        const state = getUserState(user_id);
        const tf = state.ticketFlow || null;
        const lc = String(message || '').toLowerCase().trim();

        if (!tf || !tf.active) {
            state.ticketFlow = { active: true, step: 'name' };
            setUserState(user_id, state);
            await sendMessage(socket, "Sure—please provide your name.", user_id);
            return;
        }

        if (tf.step === 'name') {
            const name = String(message || '').trim();
            state.ticketFlow = { ...tf, step: 'email', name };
            setUserState(user_id, state);
            await sendMessage(socket, "Please provide your email.", user_id);
            return;
        }

        if (tf.step === 'email') {
            const email = String(message || '').trim();
            state.ticketFlow = { ...tf, step: 'issue', email };
            setUserState(user_id, state);
            await sendMessage(socket, "Please describe your issue in detail.", user_id);
            return;
        }

        if (tf.step === 'issue') {
            const issue = String(message || '').trim();
            const payload = { name: tf.name || '', email: tf.email || '', issue };
            const result = await raise_support_ticket(payload, socket);
            let out = "Your ticket has been raised successfully.";
            try {
                const parsed = JSON.parse(result);
                out = parsed && parsed.success
                    ? `Your ticket has been raised successfully. Reference: ${parsed.ticketId}.`
                    : "I couldn't create a ticket right now. Please try again later.";
            } catch (e) { }
            await sendMessage(socket, out, user_id);
            state.ticketFlow = undefined;
            setUserState(user_id, state);
            return;
        }
    };

    return { shouldHandle, handle };
}

// createIntentRouter: Top-level intent router that now always delegates to AI agent
function createIntentRouter(deps) {
    const {
        getUserState,
        setUserState,
        updatePreferences,
        pushConversation,
        agentController
    } = deps;
    async function handleIntent(socket, message, user_id) {
        const state = getUserState(user_id);
        const text = typeof message === "string" ? message : "";
        if (text) {
            pushConversation(state, 'user', text);
            updatePreferences(state, text);
        } else {
            const serialized = typeof message === "string" ? message : JSON.stringify(message);
            pushConversation(state, 'user', serialized);
        }
        setUserState(user_id, state);
        await agentController.run(socket, message, user_id);
    }
    return { handleIntent };
}

module.exports = {
    createSearchRouter,
    createOrdinalRouter,
    createCompareRouter,
    createAdminRouter,
    createSimilarRouter,
    createTicketRouter,
    createIntentRouter
};
