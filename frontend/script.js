;(function () {
    function bootAnhanceChat() {
        if (window.__anhanceChatInitialized) return;
        window.__anhanceChatInitialized = true;
        function setViewportHeight() {
            var vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
        }
        setViewportHeight();
        window.addEventListener('resize', setViewportHeight);
    // --- CONFIG & STATE ---
    const SOCKET_URL = (window.location.origin && /^https?:\/\//i.test(window.location.origin))
        ? window.location.origin
        : 'http://localhost:8096';
    const socket = io(SOCKET_URL, {
        path: "/ws/socket.io",
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
        timeout: 20000
    });

    let userId = localStorage.getItem("anhance_chatbot_user_id");
    if (!userId) {
        userId = `web_${Math.random().toString(36).substring(2, 15)}`;
        localStorage.setItem("anhance_chatbot_user_id", userId);
    }
    let isAdminModeActive = false;
    let isChatMinimized = false;
    let isHumanModeActive = false;

    const MESSAGE_STATE = {
        PENDING: "pending",
        TYPING: "typing",
        COMPLETED: "completed"
    };

    const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const messagesState = [];
    let messageIdCounter = 0;
    const pageLoadedAt = Date.now();
    let lastInteractionTimestamp = Date.now();
    let hasUserSentMessage = false;
    let scrollTriggerFired = false;
    let timeOnPageTriggerFired = false;
    let multiProductTriggerFired = false;
    let cartIdleTriggerFired = false;
    let proactiveMessageShown = false;
    let currentPageContext = null;
    let quickRepliesContainer = null;

    function createMessageState(role, state) {
        const id = ++messageIdCounter;
        const entry = { id, role, state, element: null };
        messagesState.push(entry);
        return entry;
    }

    function updateMessageState(id, state) {
        const item = messagesState.find(m => m.id === id);
        if (item) {
            item.state = state;
        }
    }

    // --- DOM ELEMENTS ---
    const chatContainer = document.getElementById("chatContainer");
    const chatMessages = document.getElementById("chatMessages");
    const chatInput = document.getElementById("chatInput");
    const sendButton = document.getElementById("sendButton");
    const closeChatButton = document.getElementById("closeChatButton");
    const refreshChatButton = document.getElementById("refreshChatButton");
    const toggleModeButton = document.getElementById("toggleModeButton");
    const chatForm = document.getElementById("chat-form");
    const chatTitle = document.getElementById("chatTitle");
    const chatSubtitle = document.getElementById("chatSubtitle");
    const chatLogo = document.getElementById("chatLogo");
    const minimizedWidget = document.getElementById("minimizedWidget");
    const widgetTeaser = document.getElementById("widgetTeaser");
    let teaserShowTimeoutId = null;
    let teaserHideTimeoutId = null;

    let followMode = false;
    let isHoveringRobot = false;
    let robotIdleTimer = null;
    let robotDirection = "left";

    const SESSION_KEYS = {
        idleGreeting: "anhance_robot_idle_greeting_shown",
        exitIntercept: "anhance_robot_exit_intercept_shown",
        contextHelp: "anhance_robot_context_help_shown"
    };

    function getLayoutForParent(state) {
        const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
        if (state === "minimized") {
            return {
                state,
                mode: "bubble",
                width: 72,
                height: 72,
                isMobile
            };
        }
        if (isMobile) {
            return {
                state,
                mode: "fullscreen",
                width: "100vw",
                height: "100vh",
                isMobile
            };
        }
        return {
            state,
            mode: "panel",
            width: 420,
            height: 640,
            isMobile
        };
    }

    function notifyParentLayout(state) {
        try {
            const layout = getLayoutForParent(state);
            window.parent.postMessage({ type: "anhanceChat-layout", layout }, "*");
            window.parent.postMessage({ type: "turbanteeChat-toggle", visible: state === "open" }, "*");
        } catch (e) {}
    }

    function updateModeToggleButton(active) {
        isHumanModeActive = !!active;
        if (!toggleModeButton) return;
        if (isHumanModeActive) {
            toggleModeButton.title = "Switch back to AI assistant";
        } else {
            toggleModeButton.title = "Switch to human support";
        }
    }

    function clearTeaserTimers() {
        if (teaserShowTimeoutId !== null) {
            clearTimeout(teaserShowTimeoutId);
            teaserShowTimeoutId = null;
        }
        if (teaserHideTimeoutId !== null) {
            clearTimeout(teaserHideTimeoutId);
            teaserHideTimeoutId = null;
        }
    }

    function hideTeaser() {
        if (!widgetTeaser) return;
        clearTeaserTimers();
        widgetTeaser.classList.remove("visible");
    }

    function scheduleTeaser() {
        if (!widgetTeaser) return;
        hideTeaser();
        teaserShowTimeoutId = setTimeout(() => {
            if (!isChatMinimized) return;
            widgetTeaser.classList.add("visible");
            teaserHideTimeoutId = setTimeout(() => {
                widgetTeaser.classList.remove("visible");
                teaserHideTimeoutId = null;
            }, 8000);
        }, 2000);
    }

    // --- INITIALIZATION ---
    async function initializeChat() {
        const isStandalone = window.self === window.top;
        if (isStandalone) {
            isChatMinimized = false;
            if (minimizedWidget) minimizedWidget.classList.remove("visible");
            if (chatContainer) {
                chatContainer.classList.remove("chat-minimized");
                chatContainer.style.transform = "translateY(0) scale(1)";
                chatContainer.style.opacity = "1";
                chatContainer.style.pointerEvents = "auto";
            }
            notifyParentLayout("open");
        } else {
            isChatMinimized = true;
            if (minimizedWidget) minimizedWidget.classList.add("visible");
            if (chatContainer) chatContainer.classList.add("chat-minimized");
            scheduleTeaser();
            notifyParentLayout("minimized");
        }
        setupEventListeners();
        setupSocketListeners();
        trackPageTypeForSession();
        setupBehaviorTracking();
        await loadBotConfig();
        loadChatHistory();
        console.log("Chat Initialized. User ID:", userId);
        startRobotWalkSequence();
        showContextualRobotHelpOnce();
    }

    // --- CHAT HISTORY MANAGEMENT ---
    function saveMessageToHistory(messageObject) {
        try {
            let history = JSON.parse(localStorage.getItem('anhance_chat_history')) || [];
            history.push(messageObject);
            if (history.length > 50) {
                history.shift();
            }
            localStorage.setItem('anhance_chat_history', JSON.stringify(history));
        } catch (e) {
            console.error("Could not save message to history:", e);
        }
    }

    let botTitle = "Your AI Assistant";
    let botSubtitle = "Authentic supplements, smarter product guidance, and fast support.";
    let welcomeVariants = [
        `Welcome to ${botTitle}. I can help you discover the right protein, creatine, vitamins, and wellness products, plus answer shipping, return, or order questions.`,
        `Welcome to ${botTitle}. Tell me your goal, budget, or dietary preference and I will suggest the most relevant Nutrabay options.`,
        `Welcome to ${botTitle}. Ask me about whey, plant protein, fish oil, multivitamins, pre-workout, offers, shipping, or returns.`
    ];

    function applyUiTheme(theme) {
        if (!theme || typeof theme !== "object") return;
        if (theme.pageTitle && typeof theme.pageTitle === "string") {
            document.title = theme.pageTitle;
        }
        if (!isAdminModeActive) {
            if (chatTitle && theme.chatbotName && typeof theme.chatbotName === "string") {
                chatTitle.textContent = theme.chatbotName;
            }
            if (chatSubtitle && theme.chatbotSubtitle && typeof theme.chatbotSubtitle === "string") {
                chatSubtitle.textContent = theme.chatbotSubtitle;
            }
        }
        if (chatLogo && theme.logoUrl && typeof theme.logoUrl === "string") {
            chatLogo.src = theme.logoUrl;
        }

        // Apply Fonts
        if (theme.fonts) {
            if (theme.fonts.primary) document.documentElement.style.setProperty('--font-primary', theme.fonts.primary);
            if (theme.fonts.headings) document.documentElement.style.setProperty('--font-headings', theme.fonts.headings);
        }

        // Apply Chatbot UI Styles
        if (theme.chatbotUi) {
            if (theme.chatbotUi.width) document.documentElement.style.setProperty('--chat-width', theme.chatbotUi.width);
            if (theme.chatbotUi.height) document.documentElement.style.setProperty('--chat-height', theme.chatbotUi.height);
            if (theme.chatbotUi.borderRadius) document.documentElement.style.setProperty('--chat-border-radius', theme.chatbotUi.borderRadius);
            if (theme.chatbotUi.shadow) document.documentElement.style.setProperty('--chat-shadow', theme.chatbotUi.shadow);
        }

        const colors = theme.colors && typeof theme.colors === "object" ? theme.colors : {};
        const vars = {
            "--color-bg-top": colors.bgTop,
            "--color-bg-middle": colors.bgMiddle,
            "--color-bg-bottom": colors.bgBottom,
            "--color-chat-bg": colors.chatBg,
            "--color-header-bg": colors.headerBg,
            "--color-header-border": colors.headerBorder,
            "--color-text": colors.text,
            "--color-text-muted": colors.textMuted,
            "--color-placeholder": colors.placeholder,
            "--color-accent": colors.accent,
            "--color-accent-hover": colors.accentHover,
            "--color-powered-by": colors.poweredBy,
            "--color-powered-by-link": colors.poweredByLink,
            "--color-bot-msg-bg": colors.botMsgBg,
            "--color-bot-msg-text": colors.botMsgText,
            "--color-user-msg-bg": colors.userMsgBg,
            "--color-user-msg-text": colors.userMsgText,
            "--color-input-bg": colors.inputBg,
            "--color-input-border": colors.inputBorder,
            "--color-input-text": colors.inputText,
            "--color-input-container-bg": colors.inputContainerBg,
            "--color-teaser-bg": colors.teaserBg,
            "--color-teaser-text": colors.teaserText,
            "--color-scroll-thumb": colors.scrollThumb,
            "--color-agent-gradient-start": colors.agentGradientStart,
            "--color-agent-gradient-end": colors.agentGradientEnd,
            "--color-agent-border": colors.agentBorder,
            "--color-card-bg": colors.cardBg,
            "--color-card-image-bg": colors.cardImageBg
        };
        Object.entries(vars).forEach(([key, value]) => {
            if (typeof value === "string" && value.trim()) {
                document.documentElement.style.setProperty(key, value.trim());
            }
        });
    }

    async function loadBotConfig() {
        try {
            const theme = window.ANHANCE_UI_THEME && typeof window.ANHANCE_UI_THEME === "object" ? window.ANHANCE_UI_THEME : null;
            applyUiTheme(theme);
            
            // Use window.ANHANCE_BOT_CONFIG if available
            let company = {};
            let behavior = {};
            
            if (window.ANHANCE_BOT_CONFIG && typeof window.ANHANCE_BOT_CONFIG === "object") {
                company = window.ANHANCE_BOT_CONFIG.company || {};
                behavior = window.ANHANCE_BOT_CONFIG.behavior || {};
                console.log("Bot config loaded from window.ANHANCE_BOT_CONFIG");
            }

            const title = (theme && typeof theme.chatbotName === "string" && theme.chatbotName.trim())
                ? theme.chatbotName.trim()
                : (company.chatbot_name || company.company_name);
            if (title) botTitle = title;
            
            const tagline = (theme && typeof theme.chatbotSubtitle === "string" && theme.chatbotSubtitle.trim())
                ? theme.chatbotSubtitle.trim()
                : (company.branding && company.branding.tagline ? company.branding.tagline : "");
            if (tagline) botSubtitle = tagline;

            if (behavior.greeting_message) {
                welcomeVariants = [behavior.greeting_message];
            }
            const logoUrl = (theme && typeof theme.logoUrl === "string" && theme.logoUrl.trim())
                ? theme.logoUrl.trim()
                : (company.branding && typeof company.branding.logo_url === "string" ? company.branding.logo_url.trim() : "");
            if (chatLogo && logoUrl) {
                chatLogo.src = logoUrl;
            }
            if (typeof behavior.greeting_message === 'string' && behavior.greeting_message.trim()) {
                welcomeVariants = [behavior.greeting_message.trim()];
            } else {
                welcomeVariants = [
                    `Welcome to ${botTitle}. I can help you discover the right protein, creatine, vitamins, and wellness products, plus answer shipping, return, or order questions.`,
                    `Welcome to ${botTitle}. Tell me your goal, budget, or dietary preference and I will suggest the most relevant Nutrabay options.`,
                    `Welcome to ${botTitle}. Ask me about whey, plant protein, fish oil, multivitamins, pre-workout, offers, shipping, or returns.`
                ];
            }
            if (chatTitle && !isAdminModeActive) {
                chatTitle.textContent = botTitle;
            }
            if (chatSubtitle && !isAdminModeActive) {
                chatSubtitle.textContent = botSubtitle;
            }
        } catch (e) {}
    }

    function getNextWelcomeMessage() {
        try {
            const key = 'anhance_welcome_index';
            const stored = localStorage.getItem(key);
            let index = parseInt(stored, 10);
            if (!Number.isInteger(index) || index < 0 || index >= welcomeVariants.length) {
                index = Math.floor(Math.random() * welcomeVariants.length);
            } else {
                index = (index + 1) % welcomeVariants.length;
            }
            localStorage.setItem(key, String(index));
            return welcomeVariants[index];
        } catch (e) {
            const fallbackIndex = Math.floor(Math.random() * welcomeVariants.length);
            return welcomeVariants[fallbackIndex];
        }
    }

    function loadChatHistory() {
        try {
            const history = JSON.parse(localStorage.getItem('anhance_chat_history')) || [];
            if (history.length === 0) {
                displayMessage(getNextWelcomeMessage(), "bot-message", true);
                showDefaultQuickReplies();
            } else {
                history.forEach(item => {
                    handleServerMessage(item, false);
                });
            }
        } catch (e) {
            console.error("Could not load chat history:", e);
            localStorage.removeItem('anhance_chat_history');
        }
    }

    // --- REFRESH CHAT FUNCTIONALITY ---
    function refreshChat() {
        // Add loading state to refresh button
        refreshChatButton.classList.add('loading');
        refreshChatButton.disabled = true;
        
        chatMessages.innerHTML = '';

        try {
            socket.emit('clear_history', { user_id: userId });
        } catch (e) {}
        
        localStorage.removeItem('anhance_chat_history');
        
        showTypingIndicator();
        
            setTimeout(() => {
                refreshChatButton.classList.remove('loading');
                refreshChatButton.disabled = false;
                removeTypingIndicator();
            
            displayMessage(getNextWelcomeMessage(), "bot-message", true);
            showDefaultQuickReplies();
            console.log("Chat refreshed and history cleared.");
        }, 500);
    }

    function detectPageTypeFromLocation() {
        const href = window.location.href || "";
        const path = window.location.pathname || "";
        const lowerUrl = href.toLowerCase();
        const lowerPath = path.toLowerCase();
        if (lowerPath === "/" || lowerPath === "" || lowerPath === "/index.html") return "homepage";
        if (lowerPath.includes("/cart") || lowerPath.includes("/basket") || /\bcart\b/.test(lowerUrl)) return "cart";
        if (lowerPath.includes("/checkout") || lowerPath.includes("/checkout/") || lowerPath.includes("/payment")) return "checkout";
        if (lowerPath.includes("/product") || lowerPath.includes("/products/") || lowerPath.includes("/p/")) return "product";
        if (lowerPath.includes("/category") || lowerPath.includes("/categories") || lowerPath.includes("/collection") || lowerPath.includes("/collections")) return "category";
        return "unknown";
    }

    function getPageContext() {
        const href = window.location.href || "";
        if (currentPageContext && currentPageContext.url === href) {
            return currentPageContext;
        }
        const override = window.ANHANCE_PAGE_CONTEXT && typeof window.ANHANCE_PAGE_CONTEXT === "object"
            ? window.ANHANCE_PAGE_CONTEXT
            : null;
        const explicitType = override && typeof override.type === "string" ? override.type : null;
        const bodyType = document.body && document.body.dataset && typeof document.body.dataset.pageType === "string"
            ? document.body.dataset.pageType
            : null;
        const metaTypeEl = document.querySelector('meta[name="page_type"], meta[name="page-type"]');
        const metaType = metaTypeEl && metaTypeEl.content ? metaTypeEl.content : null;
        let type = explicitType || bodyType || metaType || detectPageTypeFromLocation();
        type = String(type || "unknown").toLowerCase();
        if (type === "home") type = "homepage";
        if (type === "collection" || type === "catalog") type = "category";
        if (type === "productdetail" || type === "product_details") type = "product";
        if (type === "basket") type = "cart";
        const ctx = {
            type,
            url: href,
            path: window.location.pathname || "",
            title: document.title || "",
            referrer: document.referrer || "",
            meta: {}
        };
        const metaPrimary = document.querySelector('meta[name="category"], meta[name="product"], meta[name="keywords"]');
        if (metaPrimary && metaPrimary.content) {
            ctx.meta.primary = metaPrimary.content;
        }
        if (override && override.meta && typeof override.meta === "object") {
            ctx.meta = Object.assign({}, ctx.meta, override.meta);
        }
        currentPageContext = ctx;
        return ctx;
    }

    function trackPageTypeForSession() {
        const ctx = getPageContext();
        if (ctx.type !== "product") return;
        try {
            const key = "anhance_product_page_views";
            const raw = sessionStorage.getItem(key);
            let count = parseInt(raw || "0", 10);
            if (!Number.isInteger(count) || count < 0) count = 0;
            count += 1;
            sessionStorage.setItem(key, String(count));
        } catch (e) {}
    }

    function ensureQuickRepliesContainer() {
        if (!quickRepliesContainer) {
            quickRepliesContainer = document.createElement("div");
            quickRepliesContainer.className = "quick-replies-container";
            chatMessages.appendChild(quickRepliesContainer);
        }
        return quickRepliesContainer;
    }

    function clearQuickReplies() {
        if (quickRepliesContainer) {
            quickRepliesContainer.innerHTML = "";
        }
    }

    function getDefaultQuickRepliesForPage(context) {
        const type = context && context.type ? context.type : "unknown";
        const options = [];
        if (type === "product") {
            options.push(
                { label: "Learn about this product", message: "Learn about this product" },
                { label: "Compare products", message: "Compare this with another product" }
            );
        } else if (type === "category") {
            options.push(
                { label: "Help me choose a product", message: "Help me choose a product in this category" },
                { label: "Compare products", message: "Compare a few options from this category" }
            );
        } else if (type === "cart" || type === "checkout") {
            options.push(
                { label: "Questions before I buy", message: "I have questions before completing my purchase" },
                { label: "Check offers or discounts", message: "Check if there are any offers or discounts for my cart" }
            );
        }
        options.push(
            { label: "Help me choose a product", message: "Help me choose a product" },
            { label: "Ask a question", message: "I want to ask a question" }
        );
        const seen = new Set();
        const deduped = [];
        options.forEach(opt => {
            const key = `${opt.label}|${opt.message}`;
            if (seen.has(key)) return;
            seen.add(key);
            deduped.push(opt);
        });
        return deduped;
    }

    function showQuickReplies(options) {
        if (!Array.isArray(options) || !options.length) {
            clearQuickReplies();
            return;
        }
        const container = ensureQuickRepliesContainer();
        container.innerHTML = "";
        options.forEach(opt => {
            const btn = document.createElement("button");
            btn.className = "quick-reply-button";
            btn.textContent = opt.label;
            btn.addEventListener("click", () => {
                clearQuickReplies();
                sendQuickMessage(opt.message);
                const ctx = getPageContext();
                try {
                    socket.emit("analytics_event", {
                        user_id: userId,
                        event_type: "quick_reply",
                        label: opt.label,
                        payload: opt.message,
                        page_context: ctx
                    });
                } catch (e) {}
            });
            container.appendChild(btn);
        });
        scrollToBottom(chatMessages);
    }

    function showDefaultQuickReplies() {
        const ctx = getPageContext();
        const options = getDefaultQuickRepliesForPage(ctx);
        showQuickReplies(options);
    }

    function onUserInteraction() {
        lastInteractionTimestamp = Date.now();
    }

    function triggerProactiveMessage(triggerType) {
        if (proactiveMessageShown) return;
        proactiveMessageShown = true;
        const ctx = getPageContext();
        let text = "";
        if (ctx.type === "product") {
            text = "I can help you understand this product and whether it fits your goal.";
        } else if (ctx.type === "category") {
            text = "Need help choosing the right supplement for your goal?";
        } else if (ctx.type === "cart" || ctx.type === "checkout") {
            text = "Any questions before you checkout? I can help with products, shipping, or returns.";
        } else {
            text = "Need help with supplements, nutrition goals, shipping, or getting started?";
        }
        displayMessage(text, "bot-message", true);
        showDefaultQuickReplies();
        try {
            socket.emit("analytics_event", {
                user_id: userId,
                event_type: "trigger",
                trigger_type: triggerType,
                page_context: ctx
            });
        } catch (e) {}
    }

    function handleScrollActivity() {
        onUserInteraction();
        if (proactiveMessageShown) return;
        const ctx = getPageContext();
        if (ctx.type !== "product" || scrollTriggerFired) return;
        const doc = document.documentElement || document.body;
        const scrollTop = doc.scrollTop || window.scrollY || 0;
        const scrollHeight = doc.scrollHeight || 0;
        const viewport = window.innerHeight || 1;
        const ratio = scrollHeight > 0 ? (scrollTop + viewport) / scrollHeight : 0;
        if (ratio > 0.6) {
            scrollTriggerFired = true;
            triggerProactiveMessage("product_scroll");
        }
    }

    function checkProactiveConditions() {
        if (proactiveMessageShown || hasUserSentMessage) return;
        const now = Date.now();
        const ctx = getPageContext();
        const timeOnPage = now - pageLoadedAt;
        const idleFor = now - lastInteractionTimestamp;
        if (!timeOnPageTriggerFired && timeOnPage > 15000) {
            timeOnPageTriggerFired = true;
            triggerProactiveMessage("time_on_page");
            return;
        }
        if (!cartIdleTriggerFired && (ctx.type === "cart" || ctx.type === "checkout") && idleFor > 20000) {
            cartIdleTriggerFired = true;
            triggerProactiveMessage("cart_idle");
            return;
        }
        if (!multiProductTriggerFired && ctx.type === "product") {
            let views = 0;
            try {
                views = parseInt(sessionStorage.getItem("anhance_product_page_views") || "0", 10);
            } catch (e) {
                views = 0;
            }
            if (views >= 3) {
                multiProductTriggerFired = true;
                triggerProactiveMessage("multi_product_views");
            }
        }
    }

    function setupBehaviorTracking() {
        lastInteractionTimestamp = Date.now();
        window.addEventListener("scroll", handleScrollActivity);
        window.addEventListener("mousemove", onUserInteraction);
        window.addEventListener("keydown", onUserInteraction);
        setInterval(checkProactiveConditions, 5000);
    }

    function handleRobotCursorEffects(e) {
        if (!minimizedWidget) return;
        try {
            const rect = minimizedWidget.getBoundingClientRect();
            const robotX = rect.left + rect.width / 2;
            const robotY = rect.top + rect.height / 2;
            const angle = Math.atan2(e.clientY - robotY, e.clientX - robotX);
            const deg = Math.max(-25, Math.min(25, angle * 180 / Math.PI));
            minimizedWidget.style.setProperty("--robot-look-angle", `${deg}deg`);
        } catch (err) {}
    }

    function showContextualRobotHelpOnce() {
        if (!widgetTeaser) return;
        if (sessionStorage.getItem(SESSION_KEYS.contextHelp)) return;
        const path = (window.location && window.location.pathname ? window.location.pathname : "").toLowerCase();
        let msg = "";
        if (path.includes("pricing")) {
            msg = "Need help finding the right Nutrabay product?";
        } else if (path.includes("product")) {
            msg = "I can help you compare this product with other Nutrabay options.";
        } else if (path.includes("contact")) {
            msg = "Want help contacting the right team?";
        }
        if (!msg) return;
        sessionStorage.setItem(SESSION_KEYS.contextHelp, "true");
        showRobotMessage(msg);
    }

    function showRobotMessage(text) {
        if (!widgetTeaser || !text) return;
        widgetTeaser.textContent = text;
        widgetTeaser.classList.add("visible");
        setTimeout(() => {
            widgetTeaser && widgetTeaser.classList.remove("visible");
        }, 8000);
    }

    function escortRobotNearChat() {
        if (!minimizedWidget) return;
        minimizedWidget.classList.remove("walking");
        minimizedWidget.classList.add("wave");
        minimizedWidget.style.transition = "transform 2s ease";
        minimizedWidget.style.transform = "translateX(0px)";
    }

    function showRobotGreeting() {
        if (!minimizedWidget || !widgetTeaser) return;
        if (sessionStorage.getItem(SESSION_KEYS.idleGreeting)) return;
        sessionStorage.setItem(SESSION_KEYS.idleGreeting, "true");
        escortRobotNearChat();
        showRobotMessage("Hi! Need help choosing the right supplement?");
    }

    function showExitInterception() {
        if (!minimizedWidget || !widgetTeaser) return;
        if (sessionStorage.getItem(SESSION_KEYS.exitIntercept)) return;
        sessionStorage.setItem(SESSION_KEYS.exitIntercept, "true");
        escortRobotNearChat();
        showRobotMessage("Before you go, need help with products, delivery, or returns?");
    }

    function resetRobotIdleTimer() {
        if (!minimizedWidget) return;
        clearTimeout(robotIdleTimer);
        if (widgetTeaser) {
            widgetTeaser.classList.remove("visible");
        }
        robotIdleTimer = setTimeout(() => {
            showRobotGreeting();
        }, 10000);
    }

    document.addEventListener("mousemove", (e) => {
        handleRobotCursorEffects(e);
        resetRobotIdleTimer();
    });
    document.addEventListener("scroll", resetRobotIdleTimer);
    document.addEventListener("click", resetRobotIdleTimer);
    resetRobotIdleTimer();

    document.addEventListener("mouseleave", (e) => {
        if (e.clientY <= 0) {
            showExitInterception();
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            showExitInterception();
        }
    });

    function startRobotWalkSequence() {
        if (!minimizedWidget) return;
        const robotBody = document.querySelector(".widget-icon");
        const screenWidth = window.innerWidth;
        const robotWidth = 120;
        if (robotDirection === "left") {
            if (robotBody) {
                robotBody.style.transform = "scaleX(-1)";
            }
            minimizedWidget.classList.add("walking");
            minimizedWidget.style.transition = "transform 10s linear";
            const distance = screenWidth - robotWidth - 40;
            minimizedWidget.style.transform = `translateX(-${distance}px)`;
            setTimeout(() => {
                robotDirection = "right";
                pauseRobotWalking();
            }, 10000);
        } else {
            if (robotBody) {
                robotBody.style.transform = "scaleX(1)";
            }
            minimizedWidget.classList.add("walking");
            minimizedWidget.style.transition = "transform 10s linear";
            minimizedWidget.style.transform = "translateX(0px)";
            setTimeout(() => {
                robotDirection = "left";
                pauseRobotWalking();
            }, 10000);
        }
    }

    function pauseRobotWalking() {
        if (!minimizedWidget) return;
        minimizedWidget.classList.remove("walking");
        setTimeout(() => {
            minimizedWidget.classList.add("walking");
            startRobotWalkSequence();
        }, 2000);
    }

    // --- CHAT VISIBILITY FUNCTIONS ---
    function minimizeChat() {
        if (isChatMinimized) return;
        
        isChatMinimized = true;
        if (chatContainer) {
            chatContainer.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
            chatContainer.style.transform = 'translateY(100%) scale(0.8)';
            chatContainer.style.opacity = '0';
            chatContainer.style.pointerEvents = 'none';
        }
        setTimeout(() => {
            if (chatContainer) {
                chatContainer.classList.add('chat-minimized');
            }
            if (minimizedWidget) {
                minimizedWidget.classList.add('visible');
            }
            scheduleTeaser();
        }, 300);
        notifyParentLayout("minimized");
        try {
            window.parent.postMessage({ type: "anhanceChat-close" }, "*");
        } catch (e) {}
    }
    
    function restoreChat() {
        if (!isChatMinimized) return;
        
        isChatMinimized = false;
        hideTeaser();
        
        if (minimizedWidget) minimizedWidget.classList.remove('visible');
        if (chatContainer) chatContainer.classList.remove('chat-minimized');
        
        setTimeout(() => {
            if (!chatContainer) return;
            chatContainer.style.transform = 'translateY(0) scale(1)';
            chatContainer.style.opacity = '1';
            chatContainer.style.pointerEvents = 'auto';
        }, 50);
        
        notifyParentLayout("open");
    }

    // --- ADMIN MODE UI ---
    function activateAdminMode() {
        if (isAdminModeActive) return;
        isAdminModeActive = true;
        document.body.classList.add('admin-mode');
        chatTitle.textContent = "ADMIN MODE";
        chatSubtitle.textContent = "Awaiting Your Command";
    }

    function deactivateAdminMode() {
        if (!isAdminModeActive) return;
        isAdminModeActive = false;
        document.body.classList.remove('admin-mode');
        chatTitle.textContent = botTitle;
        chatSubtitle.textContent = botSubtitle;
    }

    // --- UI & DISPLAY FUNCTIONS ---
    function displayMessage(message, type, shouldSave = true, imageUrl = null) {
        removeTypingIndicator();
        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${type}`;
        
        if (type === "agent-message") {
            const header = document.createElement("div");
            header.className = "agent-header";
            const badge = document.createElement("div");
            badge.className = "agent-badge";
            badge.textContent = "Human Support";
            header.appendChild(badge);

            const body = document.createElement("div");
            body.className = "agent-body";
            body.innerHTML = message;

            msgDiv.appendChild(header);
            msgDiv.appendChild(body);
        } else {
            msgDiv.innerHTML = message;
        }
        
        // Add image if provided
        if (imageUrl) {
            const img = document.createElement("img");
            img.src = imageUrl;
            img.alt = "Product image";
            img.style.cssText = "max-width: 200px; max-height: 200px; border-radius: 8px; margin-top: 8px; display: block;";
            msgDiv.appendChild(img);
        }
        
        chatMessages.appendChild(msgDiv);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: 'message', data: message, sender: type, imageUrl: imageUrl });
        }
    }

    function displayProductCatalog(products, shouldSave = true, append = true) {
        removeTypingIndicator();
        if (!append) {
            const existingContainers = chatMessages.querySelectorAll('.card-container');
            existingContainers.forEach(el => el.remove());
        }
        const container = document.createElement('div');
        container.className = 'card-container';
        products.forEach((product, idx) => {
            const card = document.createElement('div');
            card.className = 'bot-card';
            const imageUrl = product.imageUrl || `https://placehold.co/360x200/CD7F32/FDFCEF?text=${encodeURIComponent(product.name)}`;
            
            let priceHTML = `<span class="price">${escapeHTML(product.price)}</span>`;
            if (product.isOnSale && product.originalPrice) {
                priceHTML = `<span class="original-price">${escapeHTML(product.originalPrice)}</span> <span class="sale-price">${escapeHTML(product.price)}</span>`;
            }

            let ratingHTML = '';
            const ratingRaw = (product && (product.rating ?? product.ratingValue ?? product.averageRating ?? product.avgRating)) ?? null;
            let ratingValue = null;
            if (typeof ratingRaw === 'number' && Number.isFinite(ratingRaw)) {
                ratingValue = ratingRaw;
            } else if (typeof ratingRaw === 'string' && ratingRaw.trim() !== '') {
                const parsed = Number(ratingRaw);
                if (Number.isFinite(parsed)) ratingValue = parsed;
            }

            const reviewCountRaw = (product && (product.reviewCount ?? product.ratingCount ?? product.reviewsCount ?? product.reviews_count)) ?? null;
            let reviewCountValue = null;
            if (typeof reviewCountRaw === 'number' && Number.isFinite(reviewCountRaw)) {
                reviewCountValue = reviewCountRaw;
            } else if (typeof reviewCountRaw === 'string' && reviewCountRaw.trim() !== '') {
                const parsed = Number(reviewCountRaw);
                if (Number.isFinite(parsed)) reviewCountValue = parsed;
            }

            if (ratingValue !== null) {
                ratingValue = Math.max(0, Math.min(5, ratingValue));
                if (ratingValue > 0) {
                    const fullStars = Math.max(0, Math.min(5, Math.round(ratingValue)));
                    const stars = 'â˜…'.repeat(fullStars) + 'â˜†'.repeat(5 - fullStars);
                    const count = (typeof reviewCountValue === 'number' && Number.isFinite(reviewCountValue) && reviewCountValue > 0)
                        ? ` (${escapeHTML(String(reviewCountValue))})`
                        : '';
                    ratingHTML = `<div class="rating"><span class="rating-stars">${stars}</span> <span class="rating-text">${ratingValue.toFixed(1)}/5${count}</span></div>`;
                }
            }

            let promotionHTML = '';
            if (Array.isArray(product.promotions) && product.promotions.length) {
                const promos = product.promotions.slice(0, 2).map(p => `<span class="promotion-badge">${escapeHTML(p)}</span>`).join('');
                promotionHTML = `<div class="promotion-row">${promos}</div>`;
            }

            let sizesHTML = '';
            const sizes = Array.isArray(product.sizes) ? product.sizes.map(s => s && s.name).filter(Boolean) : [];
            if (sizes.length) {
                sizesHTML = `<div class="sizes">Available sizes: ${escapeHTML(sizes.join(', '))}</div>`;
            }

            let summaryHTML = '';
            const summarySource = product.shortDescription || product.description || '';
            if (summarySource) {
                const trimmed = String(summarySource).replace(/\s+/g, ' ').trim();
                const short = trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
                summaryHTML = `<div class="card-desc">${escapeHTML(short)}</div>`;
            }

            card.innerHTML = `
                <div class="bot-card-image-wrap">
                    <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(product.name)}" class="bot-card-image">
                </div>
                <h3>${escapeHTML(product.name)}</h3>
                ${summaryHTML}
                <div class="card-footer">
                    ${promotionHTML}
                    ${priceHTML}
                    ${ratingHTML}
                    ${sizesHTML}
                    <div class="card-actions">
                        <a href="${escapeHTML(product.link)}" target="_blank" rel="noopener noreferrer" class="card-button">View product</a>
                        <button type="button" class="card-secondary-button" data-action="ask">Ask about this</button>
                        <button type="button" class="card-secondary-button" data-action="add">Add to cart</button>
                    </div>
                </div>`;
            const detailsLink = card.querySelector('.card-button');
            const askButton = card.querySelector('.card-secondary-button[data-action="ask"]');
            const addButton = card.querySelector('.card-secondary-button[data-action="add"]');
            if (detailsLink) {
                detailsLink.addEventListener('click', () => {
                    const productId = (product && product.id != null) ? String(product.id) : null;
                    hasUserSentMessage = true;
                    displayMessage(`View Details: ${escapeHTML(product.name)}`, 'user-message');
                    socket.emit('message', {
                        user_id: userId,
                        message: {
                            type: 'PRODUCT_SELECT',
                            data: {
                                action: 'details',
                                selectionIndex: idx,
                                productId
                            }
                        },
                        page_context: getPageContext()
                    });
                    showTypingIndicator();
                });
            }
            if (askButton) {
                askButton.addEventListener('click', () => {
                    const productId = (product && product.id != null) ? String(product.id) : null;
                    hasUserSentMessage = true;
                    displayMessage("Learn about this product", "user-message");
                    socket.emit('message', {
                        user_id: userId,
                        message: {
                            type: 'PRODUCT_SELECT',
                            data: {
                                action: 'details',
                                selectionIndex: idx,
                                productId
                            }
                        },
                        page_context: getPageContext()
                    });
                    showTypingIndicator();
                });
            }
            if (addButton) {
                addButton.addEventListener('click', () => {
                    hasUserSentMessage = true;
                    const ctx = getPageContext();
                    const detail = { product, index: idx, pageContext: ctx };
                    try {
                        const evt = new CustomEvent('anhanceChat-addToCart', { detail });
                        window.dispatchEvent(evt);
                    } catch (e) {}
                    try {
                        socket.emit("analytics_event", {
                            user_id: userId,
                            event_type: "add_to_cart_click",
                            page_context: ctx,
                            product: {
                                id: product && product.id,
                                name: product && product.name
                            }
                        });
                    } catch (e) {}
                });
            }
            container.appendChild(card);
        });
        chatMessages.appendChild(container);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: '__PRODUCT_CATALOG__', data: products });
        }
    }

    function displayPricingPlans(plans, shouldSave = true) {
        removeTypingIndicator();
        const container = document.createElement('div');
        container.className = 'card-container';
        plans.forEach(plan => {
            const card = document.createElement('div');
            card.className = 'bot-card';
            const featuresList = plan.features.map(feature => `<li>${escapeHTML(feature)}</li>`).join('');
            card.innerHTML = `
                <h3>${escapeHTML(plan.name)}</h3>
                <ul class="features">${featuresList}</ul>
                <div class="card-footer">
                    <span class="price">${escapeHTML(plan.price)}</span>
                    <a href="${escapeHTML(plan.link)}" target="_blank" class="card-button">View Plan</a>
                </div>`;
            container.appendChild(card);
        });
        chatMessages.appendChild(container);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: '__PRICING_PLANS__', data: plans });
        }
    }

    function displayServiceCards(cards, shouldSave = true, append = true) {
        removeTypingIndicator();
        if (!append) {
            const existingContainers = chatMessages.querySelectorAll('.card-container');
            existingContainers.forEach(el => el.remove());
        }
        const container = document.createElement('div');
        container.className = 'card-container';
        cards.forEach(cardData => {
            const card = document.createElement('div');
            card.className = 'bot-card';
            const imageUrl = cardData.imageUrl || `https://placehold.co/360x200/2b2d55/FFFFFF?text=${encodeURIComponent(cardData.name || 'Service')}`;
            const description = cardData.description ? `<div class="card-desc">${escapeHTML(cardData.description)}</div>` : '';
            const link = cardData.link || 'https://nutrabay.com/all-categories/';
            card.innerHTML = `
                <div class="bot-card-image-wrap">
                    <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(cardData.name || 'Service')}" class="bot-card-image">
                </div>
                <h3>${escapeHTML(cardData.name || 'Service')}</h3>
                ${description}
                <div class="card-footer">
                    <a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer" class="card-button">View Page</a>
                </div>`;
            container.appendChild(card);
        });
        chatMessages.appendChild(container);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: '__SERVICE_CARDS__', data: cards });
        }
    }

    function displayAdminDashboard(dashboardData, shouldSave = true) {
        removeTypingIndicator();
        const dashboardDiv = document.createElement('div');
        dashboardDiv.className = 'admin-dashboard';
        const optionsHTML = dashboardData.options.map(opt => 
            `<button class="admin-option-btn" data-command="${escapeHTML(opt.command)}">${escapeHTML(opt.label)}</button>`
        ).join('');
        dashboardDiv.innerHTML = `
            <h3>${escapeHTML(dashboardData.title)}</h3>
            <div class="admin-options">${optionsHTML}</div>
        `;
        chatMessages.appendChild(dashboardDiv);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: '__ADMIN_DASHBOARD__', data: dashboardData });
        }
    }

    function displayAdminReport(reportData, shouldSave = true) {
        removeTypingIndicator();
        const reportDiv = document.createElement('div');
        reportDiv.className = 'admin-report-card';
        reportDiv.innerHTML = `
            <h4>${escapeHTML(reportData.title)}</h4>
            <p>${escapeHTML(reportData.content)}</p>
        `;
        chatMessages.appendChild(reportDiv);
        scrollToBottom(chatMessages);
        if (shouldSave) {
            saveMessageToHistory({ type: '__ADMIN_REPORT__', data: reportData });
        }
    }

    function displayShowMoreButton() {
        removeShowMoreButton();
        const button = document.createElement('button');
        button.id = 'show-more-btn';
        button.className = 'show-more-button';
        button.textContent = 'Show More';
        chatMessages.appendChild(button);
        scrollToBottom(chatMessages);

        button.addEventListener('click', () => {
            hasUserSentMessage = true;
            displayMessage('Show More', 'user-message');
            socket.emit('message', { user_id: userId, message: 'show more products', page_context: getPageContext() });
            button.remove();
            showTypingIndicator();
        });
    }

    function removeShowMoreButton() {
        const existingButton = document.getElementById('show-more-btn');
        if (existingButton) {
            existingButton.remove();
        }
    }

    function showTypingIndicator() {
        if (document.getElementById("typing-indicator")) return;
        const typingMsg = document.createElement("div");
        typingMsg.className = "message bot-message typing-indicator";
        typingMsg.id = "typing-indicator";
        typingMsg.innerHTML = `<span></span><span></span><span></span>`;
        chatMessages.appendChild(typingMsg);
        scrollToBottom(chatMessages);
    }

    function removeTypingIndicator() {
        const existing = document.getElementById("typing-indicator");
        if (existing) existing.remove();
    }

    function scrollToBottom(element) {
        if (!element) return;
        if (!prefersReducedMotion && typeof element.scrollTo === "function") {
            element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
        } else {
            element.scrollTop = element.scrollHeight;
        }
    }

    function sendQuickMessage(message) {
        const text = String(message || "").trim();
        if (!text) return;
        hasUserSentMessage = true;
        onUserInteraction();
        clearQuickReplies();
        displayMessage(text, "user-message");
        socket.emit("message", { user_id: userId, message: text, page_context: getPageContext() });
        showTypingIndicator();
        if (chatInput) {
            chatInput.focus();
        }
    }

    function escapeHTML(str) {
        if (typeof str !== 'string') return '';
        const p = document.createElement('p');
        p.textContent = str;
        return p.innerHTML;
    }

    function renderBotMessageWithTyping(html, shouldSave = true, fromHistory = false, imageUrl = null) {
        if (fromHistory || prefersReducedMotion) {
            displayMessage(html, "bot-message", shouldSave, imageUrl);
            return;
        }

        const messageState = createMessageState("bot", MESSAGE_STATE.PENDING);
        const msgDiv = document.createElement("div");
        msgDiv.className = "message bot-message";
        messageState.element = msgDiv;

        const initialDelay = 400 + Math.random() * 400;

        setTimeout(() => {
            removeTypingIndicator();
            chatMessages.appendChild(msgDiv);
            scrollToBottom(chatMessages);
            updateMessageState(messageState.id, MESSAGE_STATE.TYPING);

            const tempContainer = document.createElement("div");
            tempContainer.innerHTML = html;

            const textNodes = [];

            function collectTextNodes(node, parentTag) {
                node.childNodes.forEach(child => {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const fullText = child.textContent || "";
                        if (fullText.trim().length > 0) {
                            textNodes.push({ node: child, fullText, parentTag });
                            child.textContent = "";
                        }
                    } else {
                        collectTextNodes(child, child.nodeName);
                    }
                });
            }

            collectTextNodes(tempContainer, tempContainer.nodeName);
            msgDiv.appendChild(tempContainer);

            if (textNodes.length === 0) {
                updateMessageState(messageState.id, MESSAGE_STATE.COMPLETED);
                if (shouldSave) {
                    saveMessageToHistory({ type: 'message', data: html, sender: 'bot-message', imageUrl });
                }
                return;
            }

            let nodeIndex = 0;
            let charIndex = 0;
            const baseDelay = 18;
            const chunkSize = 2;

            function step() {
                if (nodeIndex >= textNodes.length) {
                    updateMessageState(messageState.id, MESSAGE_STATE.COMPLETED);
                    if (shouldSave) {
                        saveMessageToHistory({ type: 'message', data: html, sender: 'bot-message', imageUrl });
                    }
                    return;
                }

                const current = textNodes[nodeIndex];
                const remaining = current.fullText.length - charIndex;
                const take = Math.min(chunkSize, remaining);
                current.node.textContent += current.fullText.slice(charIndex, charIndex + take);
                charIndex += take;
                scrollToBottom(chatMessages);

                let delay = baseDelay;

                if (charIndex >= current.fullText.length) {
                    nodeIndex += 1;
                    charIndex = 0;
                    const tag = (current.parentTag || "").toUpperCase();
                    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "LI") {
                        delay += 280;
                    }
                }

                setTimeout(step, delay);
            }

            step();
        }, initialDelay);
    }

    // --- EVENT & SOCKET LISTENERS ---
    function setupEventListeners() {
        if (sendButton) {
            sendButton.addEventListener("click", handleUserInput);
        }
        if (chatForm) {
            chatForm.addEventListener("submit", (e) => {
                e.preventDefault();
                handleUserInput();
            });
        }
        if (closeChatButton) {
            closeChatButton.addEventListener("click", minimizeChat);
        }
        if (refreshChatButton) {
            refreshChatButton.addEventListener("click", refreshChat);
        }
        if (minimizedWidget) {
            minimizedWidget.addEventListener("click", restoreChat);
            minimizedWidget.addEventListener("mouseenter", () => {
                isHoveringRobot = true;
                minimizedWidget.classList.add("wave");
                minimizedWidget.classList.remove("walking");
            });
            minimizedWidget.addEventListener("mouseleave", () => {
                isHoveringRobot = false;
                minimizedWidget.classList.remove("wave");
                minimizedWidget.classList.add("walking");
            });
        }
        if (toggleModeButton) {
            toggleModeButton.addEventListener("click", () => {
                const next = !isHumanModeActive;
                const type = next ? "HUMAN_ON" : "HUMAN_OFF";
                onUserInteraction();
                updateModeToggleButton(next);
                socket.emit("message", { user_id: userId, message: { type }, page_context: getPageContext() });
                showTypingIndicator();
            });
        }

        // Listen for messages from parent window to minimize chat
        window.addEventListener('message', (event) => {
            if (event.data && (event.data.type === 'anhanceChat-toggle' || event.data.type === 'turbanteeChat-toggle')) {
                if (event.data.visible) {
                    restoreChat();
                } else {
                    minimizeChat();
                }
            }
        });

        chatMessages.addEventListener('click', (e) => {
            if (e.target && e.target.classList.contains('admin-option-btn')) {
                const command = e.target.dataset.command;
                if (command) {
                    hasUserSentMessage = true;
                    onUserInteraction();
                    displayMessage(e.target.textContent, "user-message");
                    socket.emit("message", { user_id: userId, message: command, page_context: getPageContext() });
                    showTypingIndicator();
                }
            }
        });
    }

    function handleServerMessage(data, shouldSave = true) {
        console.log("Received message from server:", data);

        const payload = (data && typeof data === 'object' && 'message' in data)
            ? data.message
            : data;

        let messageType = 'message';
        let messageData = payload;
        let sender = 'bot-message';
        let imageUrl = null;

        if (typeof payload === 'object' && payload !== null && payload.type) {
            messageType = payload.type;
            messageData = payload.data;
            sender = payload.sender || 'bot-message';
            imageUrl = payload.imageUrl || null;
        } else if (typeof payload === 'string' && payload.startsWith("__")) {
            const parts = payload.split('__');
            const command = parts[1];
            const rest = parts.slice(2).join('__');
            messageType = command;
            try {
                messageData = JSON.parse(rest);
            } catch(e) {
                messageData = rest;
            }
        }

        switch (messageType) {
            case '__PRODUCT_CATALOG__':
                displayProductCatalog(messageData, shouldSave, true);
                break;
            case '__CONTROL_CLEAR_CATALOG__':
                try {
                    const containers = chatMessages.querySelectorAll('.card-container');
                    containers.forEach(c => c.remove());
                    removeShowMoreButton();
                } catch(e) {}
                break;
            case '__PRICING_PLANS__':
                displayPricingPlans(messageData, shouldSave);
                break;
            case '__SERVICE_CARDS__':
                displayServiceCards(messageData, shouldSave, true);
                break;
            case '__CONTROL_SHOW_MORE__':
                if (messageData.show) {
                    displayShowMoreButton();
                } else {
                    removeShowMoreButton();
                }
                break;
            case '__ADMIN_DASHBOARD__':
                activateAdminMode();
                displayAdminDashboard(messageData, shouldSave);
                break;
            case '__ADMIN_REPORT__':
                displayAdminReport(messageData, shouldSave);
                break;
            case '__ADMIN_MODE_DEACTIVATED__':
                deactivateAdminMode();
                displayMessage("Admin mode deactivated.", "bot-message", shouldSave);
                break;
            case '__CONTROL_HUMAN_MODE__':
                updateModeToggleButton(!!(messageData && messageData.active));
                break;
            case 'message':
            default:
                if (sender === 'bot-message' && typeof messageData === 'string') {
                    renderBotMessageWithTyping(messageData, shouldSave, !shouldSave, imageUrl);
                } else {
                    displayMessage(messageData, sender, shouldSave, imageUrl);
                }
                break;
        }
    }

    function setupSocketListeners() {
        socket.on("connect", () => {
            console.log("âœ… Connected to WebSocket server.");
            try {
                socket.emit("init", { user_id: userId, page_context: getPageContext() });
            } catch (e) {}
        });
        socket.on("disconnect", () => console.log("ðŸ”Œ Disconnected from WebSocket server."));
        socket.on("connect_error", (err) => console.error("Connection Error:", err.message));
        socket.on("message", (data) => handleServerMessage(data, true));
    }

    // --- START CHAT ---
    function handleUserInput() {
        const message = chatInput.value.trim();
        if (!message) return;

        sendQuickMessage(message);
        chatInput.value = "";
        chatInput.focus();
    }

    // --- START CHAT ---
    initializeChat();
    }

    window.AnhanceBootChat = bootAnhanceChat;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootAnhanceChat);
    } else {
        bootAnhanceChat();
    }
})();




