;(function () {
    var cursor = { x: 0, y: 0, vx: 0, vy: 0, lastX: 0, lastY: 0, lastTime: 0 };
    var interactionEngineActive = false;
    var cursorVelocity = { x: 0, y: 0 };
    
    document.addEventListener("mousemove", function(e) {
        var now = Date.now();
        var dt = now - cursor.lastTime;
        if (dt > 0) {
            cursor.vx = (e.clientX - cursor.lastX) / dt * 16;
            cursor.vy = (e.clientY - cursor.lastY) / dt * 16;
        }
        cursor.lastX = cursor.x;
        cursor.lastY = cursor.y;
        cursor.x = e.clientX;
        cursor.y = e.clientY;
        cursor.lastTime = now;
    });
    
    document.addEventListener("touchstart", function(e) {
        const touch = e.touches && e.touches[0] ? e.touches[0] : null;
        if (touch) {
            cursor.x = touch.clientX;
            cursor.y = touch.clientY;
        }
    }, { passive: true });
    
    function getRobotPosition() {
        const robot = document.getElementById("anhance-robot-container");
        if (!robot) return { x: 0, y: 0 };
        const rect = robot.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
    }
    
    function getElementUnderCursor() {
        return document.elementFromPoint(cursor.x, cursor.y);
    }
    
    const importantSelectors = [
        "button",
        "a",
        ".cta",
        ".add-to-cart",
        ".buy-now",
        ".pricing-button",
        "[data-product]",
        "[data-cta]",
        ".btn",
        ".button",
        "input[type='submit']",
        "input[type='button']"
    ];
    
    function isImportantElement(el) {
        if (!el) return false;
        return importantSelectors.some(selector => {
            try {
                return el.closest(selector);
            } catch (e) {
                return false;
            }
        });
    }
    
    function predictCursorPosition(leadTime) {
        return {
            x: cursor.x + cursor.vx * leadTime,
            y: cursor.y + cursor.vy * leadTime
        };
    }
    
    function updateRobotMovement() {
        const robot = document.getElementById("anhance-robot-container");
        if (!robot || !interactionEngineActive || botState.isChatOpen) return;
        
        const pos = getRobotPosition();
        const predicted = predictCursorPosition(200);
        const dx = predicted.x - pos.x;
        const dy = cursor.y - pos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const movementThreshold = 120;
        const maxMoveDistance = 35;
        
        if (distance < movementThreshold) return;
        
        const direction = dx > 0 ? 1 : -1;
        const moveRatio = Math.min(1, distance / 400);
        const moveDistance = Math.min(maxMoveDistance, moveRatio * maxMoveDistance);
        const speed = Math.sqrt(cursor.vx * cursor.vx + cursor.vy * cursor.vy);
        const urgency = Math.min(1, speed / 100);
        
        const transitionTime = 0.3 + (1 - urgency) * 0.4;
        const easing = urgency > 0.5 ? "cubic-bezier(0.25, 0.46, 0.45, 0.94)" : "ease-out";
        
        robot.style.transition = `transform ${transitionTime}s ${easing}`;
        
        const wobble = Math.sin(Date.now() * 0.008) * (1 + urgency) * 2;
        const lean = cursor.vx * 0.1;
        
        robot.style.transform = `translateX(${direction * moveDistance}px) translateY(${wobble}px) rotate(${lean}deg)`;
    }
    
    function updateRobotDirection() {
        const robot = document.getElementById("anhance-robot-widget");
        if (!robot || !interactionEngineActive) return;
        
        const pos = getRobotPosition();
        if (cursor.x > pos.x) {
            robot.classList.remove("robot-flip");
        } else {
            robot.classList.add("robot-flip");
        }
    }
    
    function detectElementFocus() {
        if (!interactionEngineActive || botState.isChatOpen) return;
        
        const el = getElementUnderCursor();
        if (!el) return;
        
        if (isImportantElement(el)) {
            const now = Date.now();
            if (now - (window.lastElementPopupTime || 0) < 4000) return;
            
            const robotPos = getRobotPosition();
            const elementRect = el.getBoundingClientRect();
            const elementCenterX = elementRect.left + elementRect.width / 2;
            const elementCenterY = elementRect.top + elementRect.height / 2;
            const distance = Math.sqrt(
                Math.pow(cursor.x - elementCenterX, 2) + 
                Math.pow(cursor.y - elementCenterY, 2)
            );
            
            if (distance < 150) {
                window.lastElementPopupTime = now;
                const trigger = getTriggerTypeForElement(el);
                triggerContextualAssistant(trigger);
                
                botState.stopMovementUntil = now + 3000;
            }
        }
    }
    
    function getTriggerTypeForElement(el) {
        const text = (el.innerText || "").toLowerCase();
        const classes = (el.className || "").toLowerCase();
        
        if (text.includes("add to cart") || text.includes("buy now") || classes.includes("add-to-cart") || classes.includes("buy-now")) {
            return "product-interest";
        }
        if (text.includes("checkout") || text.includes("proceed")) {
            return "checkout-help";
        }
        if (text.includes("pricing") || text.includes("plan") || classes.includes("pricing")) {
            return "pricing-help";
        }
        if (text.includes("subscribe") || text.includes("sign up")) {
            return "subscription-help";
        }
        if (text.includes("contact") || text.includes("support")) {
            return "support-help";
        }
        if (text.includes("demo") || text.includes("trial")) {
            return "demo-help";
        }
        return "general-help";
    }
    
    function getMessageForElement(el) {
        const trigger = getTriggerTypeForElement(el);
        return triggerContextualAssistant(trigger);
    }
    
    function getRandomProductMessage() {
        const messages = [
            "Need help choosing this product?",
            "Want to know more about this item?",
            "Not sure if this is right for you?",
            "I can help you decide!",
            "Questions about this product?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomCheckoutMessage() {
        const messages = [
            "Need help completing your order?",
            "Ready to checkout? I can help!",
            "Questions about your order?",
            "Let me help you finish this!",
            "Almost done! Need any help?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomPricingMessage() {
        const messages = [
            "Need help picking the right plan?",
            "Not sure which plan suits you?",
            "I can explain the pricing options!",
            "Want to compare plans?",
            "Questions about pricing?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomSubscriptionMessage() {
        const messages = [
            "Need help with subscription?",
            "Questions about signing up?",
            "I can help you get started!",
            "Want to know more about our plans?",
            "Ready to join us?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomSupportMessage() {
        const messages = [
            "Need help? I'm here for you!",
            "Questions? I've got answers!",
            "Let me help you with that!",
            "Something on your mind?",
            "I'm here to help!"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomDemoMessage() {
        const messages = [
            "Want to see a demo?",
            "I can show you how it works!",
            "Questions about the trial?",
            "Let me walk you through it!",
            "Ready to try it out?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function getRandomGenericMessage() {
        const messages = [
            "Need help with this option?",
            "Questions? I'm here to help!",
            "Want to know more?",
            "I can assist you with this!",
            "Something I can help you with?"
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    }
    
    function showRobotMessage(message) {
        const messageEl = document.getElementById("anhance-robot-message");
        if (!messageEl) return;
        
        messageEl.textContent = message;
        messageEl.style.display = "block";
        
        setTimeout(function() {
            messageEl.style.display = "none";
        }, 3000);
    }
    
    function updateRobotAttention() {
        const robot = document.getElementById("anhance-robot-widget");
        if (!robot || !interactionEngineActive) return;
        
        const pos = getRobotPosition();
        const distance = Math.sqrt(
            Math.pow(cursor.x - pos.x, 2) + 
            Math.pow(cursor.y - pos.y, 2)
        );
        
        const speed = Math.sqrt(cursor.vx * cursor.vx + cursor.vy * cursor.vy);
        const isActive = distance < 200 || speed > 50;
        
        if (isActive) {
            robot.classList.add("robot-attentive");
            robot.classList.remove("robot-idle");
        } else {
            robot.classList.remove("robot-attentive");
            robot.classList.add("robot-idle");
        }
        
        const eyes = robot.querySelectorAll("circle[cx='45'], circle[cx='75']");
        if (eyes.length >= 2) {
            const eyeDirection = cursor.x > pos.x ? 1 : -1;
            eyes[0].style.transform = `translateX(${eyeDirection * 2}px)`;
            eyes[1].style.transform = `translateX(${eyeDirection * 2}px)`;
        }
    }
    
    function interactionEngine() {
        if (!interactionEngineActive) return;
        
        updateRobotMovement();
        updateRobotDirection();
        updateRobotAttention();
        detectElementFocus();
        
        requestAnimationFrame(interactionEngine);
    }
    
    function startInteractionEngine() {
        if (interactionEngineActive) return;
        interactionEngineActive = true;
        interactionEngine();
    }
    
    function stopInteractionEngine() {
        interactionEngineActive = false;
    }

    var botState = {
        currentPage: null,
        lastPopupTime: 0,
        popupCount: 0,
        pageVisited: new Set(),
        userIdle: false,
        isChatOpen: false,
        lastUrl: location.href,
        comparePopupShown: false
    };

    function buildRobotSvg() {
        return '<svg class="widget-robot" viewBox="0 0 120 140" width="72" height="72" aria-hidden="true"><defs><linearGradient id="robotBodyGrad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#ffb347"/><stop offset="100%" stop-color="#ff8c2b"/></linearGradient><linearGradient id="robotHeadGrad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#ffd46b"/><stop offset="100%" stop-color="#ff9d3a"/></linearGradient></defs><g id="robot-root"><rect x="10" y="40" width="100" height="70" rx="20" fill="url(#robotBodyGrad)"/><g id="robot-head"><rect x="15" y="10" width="90" height="60" rx="25" fill="url(#robotHeadGrad)"/><circle cx="45" cy="40" r="8" fill="#1a1a1a"/><circle cx="75" cy="40" r="8" fill="#1a1a1a"/><circle cx="42" cy="37" r="3" fill="#ffffff"/><circle cx="72" cy="37" r="3" fill="#ffffff"/><path d="M52 54 Q60 60 68 54" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="60" cy="6" r="4" fill="#ffb347"/><line x1="60" y1="6" x2="60" y2="10" stroke="#ffb347" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="45" r="4" fill="#ffb347"/><circle cx="100" cy="45" r="4" fill="#ffb347"/></g><rect x="40" y="96" width="40" height="20" rx="10" fill="#1a1a1a"/><circle cx="60" cy="106" r="6" fill="#ffb347"/><g id="robot-arm-right"><circle cx="110" cy="65" r="7" fill="#ffb347"/><rect x="103" y="70" width="14" height="24" rx="5" fill="#ffb347"/><circle cx="110" cy="97" r="5" fill="#ffd46b"/></g><g id="robot-arm-left"><circle cx="10" cy="65" r="7" fill="#ffb347"/><rect x="3" y="70" width="14" height="24" rx="5" fill="#ffb347"/><circle cx="10" cy="97" r="5" fill="#ffd46b"/></g><g id="robot-legs"><rect id="robot-leg-left" x="40" y="110" width="12" height="18" rx="5" fill="#ffb347"/><rect id="robot-leg-right" x="68" y="110" width="12" height="18" rx="5" fill="#ffb347"/><circle cx="46" cy="130" r="4" fill="#1a1a1a"/><circle cx="74" cy="130" r="4" fill="#1a1a1a"/></g></g></svg>';
    }

    function isMobileDevice() {
        return (
            "ontouchstart" in window ||
            navigator.maxTouchPoints > 0 ||
            window.innerWidth < 768
        );
    }

    function injectRobotStyles() {
        if (document.getElementById("anhance-robot-styles")) return;
        var style = document.createElement("style");
        style.id = "anhance-robot-styles";
        style.textContent = `
            #anhance-robot-container {
                position: fixed;
                bottom: 20px;
                right: 20px;
                display: flex;
                align-items: flex-end;
                gap: 8px;
                z-index: 999999;
                transition: transform 0.3s ease-out;
            }
            #anhance-robot-widget {
                animation: robotWalkBounce 0.6s infinite;
                width: 72px;
                height: 72px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.3s ease;
            }
            #anhance-robot-widget.robot-attentive {
                animation-duration: 0.4s;
                filter: brightness(1.1);
            }
            #anhance-robot-widget.robot-idle {
                animation-duration: 0.8s;
                opacity: 0.9;
            }
            #anhance-robot-widget .widget-robot {
                transition: transform 0.3s ease;
            }
            #anhance-robot-widget.robot-attentive .widget-robot {
                transform: scale(1.05);
            }
            @keyframes robotWalkBounce {
                0% { transform: translateY(0px); }
                50% { transform: translateY(-4px); }
                100% { transform: translateY(0px); }
            }
            #anhance-robot-widget.robot-flip .widget-robot,
            #anhance-robot-widget.robot-left .widget-robot {
                transform: scaleX(-1);
            }
            #anhance-robot-message {
                position: relative;
                background: #6366f1;
                color: #fff;
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 14px;
                max-width: 220px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.2);
                display: none;
                animation: messageFadeIn 0.3s ease;
            }
            @keyframes messageFadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            #anhance-robot-message-arrow {
                position: absolute;
                width: 0;
                height: 0;
                bottom: -6px;
                right: 16px;
                border-left: 6px solid transparent;
                border-right: 6px solid transparent;
                border-top: 6px solid #6366f1;
            }
            @media (max-width: 768px) {
                iframe[src*="anhance"], #anhance-chat-frame {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: 100vw !important;
                    max-height: 100vh !important;
                    border-radius: 0 !important;
                    z-index: 2147483647 !important;
                }
                #anhance-robot-widget {
                    width: 52px;
                    height: 52px;
                }
                #anhance-robot-message {
                    max-width: 180px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function createRobotContainer() {
        var container = document.getElementById("anhance-robot-container");
        if (container) return container;
        container = document.createElement("div");
        container.id = "anhance-robot-container";
        document.body.appendChild(container);
        return container;
    }

    function createRobotWidget() {
        var robot = document.getElementById("anhance-robot-widget");
        if (robot) return robot;
        robot = document.createElement("div");
        robot.id = "anhance-robot-widget";
        robot.style.cursor = "pointer";
        robot.style.background = "transparent";
        robot.innerHTML = buildRobotSvg();
        createRobotContainer().appendChild(robot);
        return robot;
    }

    function createRobotMessage() {
        var message = document.getElementById("anhance-robot-message");
        if (message) return message;
        message = document.createElement("div");
        message.id = "anhance-robot-message";
        var arrow = document.createElement("div");
        arrow.id = "anhance-robot-message-arrow";
        message.appendChild(arrow);
        createRobotContainer().appendChild(message);
        return message;
    }

    function createChatFrame() {
        var frame = document.getElementById("anhance-chat-frame");
        if (frame) return frame;
        frame = document.createElement("iframe");
        frame.src = "https://chat.anhance.tech";
        frame.id = "anhance-chat-frame";
        frame.style.position = "fixed";
        frame.style.bottom = "20px";
        frame.style.right = "20px";
        frame.style.width = "420px";
        frame.style.height = "640px";
        frame.style.border = "0";
        frame.style.borderRadius = "20px";
        frame.style.boxShadow = "0 12px 40px rgba(0,0,0,.15)";
        frame.style.display = "none";
        frame.style.pointerEvents = "none";
        frame.style.background = "transparent";
        frame.style.zIndex = "2147483646";
        document.body.appendChild(frame);
        return frame;
    }

    function postToFrame(frame, message) {
        if (!frame || !frame.contentWindow) return false;
        frame.contentWindow.postMessage(message, "*");
        return true;
    }

    function showChat(robot, frame, message) {
        frame.style.display = "block";
        frame.style.pointerEvents = "auto";
        robot.style.display = "none";
        botState.isChatOpen = true;
        hideRobotPopup(message);
        var sent = postToFrame(frame, { type: "anhanceChat-toggle", visible: true });
        if (!sent) {
            frame.dataset.openRequested = "true";
        }
    }

    function hideChat(robot, frame) {
        frame.style.display = "none";
        frame.style.pointerEvents = "none";
        robot.style.display = "flex";
        botState.isChatOpen = false;
    }

    function setupMessageBridge(robot, frame, message) {
        window.addEventListener("message", function (event) {
            var data = event.data || {};
            if (data.type === "turbanteeChat-toggle") {
                var visible = !!data.visible;
                if (visible) {
                    frame.style.pointerEvents = "auto";
                    frame.style.display = "block";
                    robot.style.display = "none";
                    botState.isChatOpen = true;
                    hideRobotPopup(message);
                } else {
                    frame.style.pointerEvents = "none";
                    frame.style.display = "none";
                    robot.style.display = "flex";
                    botState.isChatOpen = false;
                }
            }
            if (data.type === "anhanceChat-layout" && data.layout) {
                var mode = data.layout.mode;
                var width = data.layout.width;
                var height = data.layout.height;
                if (mode === "fullscreen") {
                    frame.style.width = "100vw";
                    frame.style.height = "100vh";
                    frame.style.borderRadius = "0";
                } else {
                    frame.style.width = width + "px";
                    frame.style.height = height + "px";
                    frame.style.borderRadius = "20px";
                }
            }
            if (data.type === "anhanceChat-close") {
                hideChat(robot, frame);
                hideRobotPopup(message);
            }
        });
    }

    function updateMessagePosition(message, robotX, robotWidth) {
        if (!message) return;
        var container = document.getElementById("anhance-robot-container");
        if (container) {
            container.style.left = robotX + "px";
            container.style.right = "";
        }
        if (isMobileDevice()) {
            message.style.maxWidth = "180px";
        } else {
            message.style.maxWidth = "220px";
        }
        var arrow = document.getElementById("anhance-robot-message-arrow");
        if (arrow) {
            arrow.style.right = "16px";
            arrow.style.left = "";
        }
    }

    function getPageContext() {
        var path = (window.location.pathname || "").toLowerCase();
        if (path.includes("product") || path.includes("shop")) {
            return "product";
        }
        if (path.includes("about")) {
            return "about";
        }
        if (path.includes("pricing") || path.includes("plan")) {
            return "pricing";
        }
        return "general";
    }

    function isPricingPage() {
        return (window.location.pathname || "").toLowerCase().includes("pricing");
    }

    function isCartPage() {
        return (window.location.pathname || "").toLowerCase().includes("cart");
    }

    function getContextMessage() {
        var context = getPageContext();
        var trigger = "page-" + context;
        return triggerContextualAssistant(trigger);
    }

    function getPageContextForPopup() {
        var title = "";
        try {
            var h1 = document.querySelector("h1");
            title = h1 && h1.innerText ? String(h1.innerText) : "";
        } catch (e) {}
        return {
            title: title,
            path: window.location.pathname || ""
        };
    }

    function applyPopupTheme(message) {
        if (!message) return;
        var themeColor = "#6366f1";
        try {
            var computed = getComputedStyle(document.body);
            var cssColor = computed.getPropertyValue("--primary-color");
            if (cssColor && cssColor.trim()) {
                themeColor = cssColor.trim();
            }
        } catch (e) {}
        message.style.background = themeColor;
        message.style.color = "#fff";
        message.style.boxShadow = "0 8px 24px rgba(0,0,0,0.2)";
        var arrow = document.getElementById("anhance-robot-message-arrow");
        if (arrow) {
            arrow.style.borderTopColor = themeColor;
        }
    }

    function hideRobotPopup(message) {
        if (!message) return;
        message.style.display = "none";
    }

    function showRobotMessage(message, text) {
        if (!message || botState.isChatOpen) return;
        applyPopupTheme(message);
        var arrow = document.getElementById("anhance-robot-message-arrow");
        message.textContent = text;
        if (arrow) {
            message.appendChild(arrow);
        }
        message.style.display = "block";
        setTimeout(function () {
            message.style.display = "none";
        }, 5000);
    }

    var viewedProducts = [];
    var aiPopupCache = {};
    var aiPopupPromiseCache = {};
    var interactionScore = 0;
    var personalityMessages = [
        "Hey there. Need help?",
        "Still looking for something?",
        "Want help choosing the right option?",
        "I can help you decide."
    ];

    function getRandomPersonality() {
        return personalityMessages[Math.floor(Math.random() * personalityMessages.length)];
    }
    
    async function getContextualPersonality() {
        return await generateContextualAIPopup("personality-general");
    }

    function canTriggerPopup() {
        var now = Date.now();
        var maxPopups = isMobileDevice() ? 1 : 2;
        if (botState.isChatOpen) return false;
        if (botState.popupCount >= maxPopups) return false;
        if (now - botState.lastPopupTime < 15000) return false;
        botState.lastPopupTime = now;
        botState.popupCount += 1;
        return true;
    }

    function hasPageTriggered() {
        var path = location.pathname || "";
        if (botState.pageVisited.has(path)) {
            return true;
        }
        botState.pageVisited.add(path);
        return false;
    }

    function showContextPopup(message) {
        var text = getContextMessage();
        triggerAssistant(message, text);
    }

    async function callAIPopup(prompt, maxTokens) {
        try {
            var response = await fetch("/api/popup-ai", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: prompt,
                    max_tokens: maxTokens
                })
            });
            if (!response.ok) return "";
            var data = await response.json();
            if (data && typeof data.message === "string") {
                return data.message.trim();
            }
        } catch (e) {}
        return "";
    }

    async function generateAIPopup() {
        var context = getPageContextForPopup();
        var path = context.path || "";
        if (aiPopupCache[path]) {
            return aiPopupCache[path];
        }
        if (aiPopupPromiseCache[path]) {
            return aiPopupPromiseCache[path];
        }
        var prompt = "Write one short assistant popup helping a visitor. Page title: " + context.title;
        aiPopupPromiseCache[path] = callAIPopup(prompt, 20).then(function (message) {
            var text = message && message.trim() ? message.trim() : "";
            if (!text) {
                text = "Need help with something here?";
            }
            aiPopupCache[path] = text;
            delete aiPopupPromiseCache[path];
            return text;
        });
        return aiPopupPromiseCache[path];
    }

    const popupCache = {};
    const popupCacheExpiry = 5 * 60 * 1000; // 5 minutes
    window.pageLoadTime = Date.now();
    
    function isCacheValid(key) {
        if (!popupCache[key]) return false;
        const now = Date.now();
        return (now - popupCache[key].timestamp) < popupCacheExpiry;
    }
    
    function getCachedPopup(key) {
        if (isCacheValid(key)) {
            return popupCache[key].message;
        }
        return null;
    }
    
    function setCachedPopup(key, message) {
        popupCache[key] = {
            message: message,
            timestamp: Date.now()
        };
    }
    
    function buildPopupContext(trigger) {
        const h1 = document.querySelector("h1");
        const title = h1 ? h1.innerText.trim() : "";
        const path = location.pathname;
        const url = location.href;
        const isMobile = isMobileDevice();
        const timeOnPage = Math.floor((Date.now() - (window.pageLoadTime || 0)) / 1000);
        
        return {
            title: title,
            path: path,
            url: url,
            trigger: trigger,
            isMobile: isMobile,
            timeOnPage: timeOnPage,
            pageType: classifyPage()
        };
    }
    
    async function generateContextualAIPopup(trigger) {
        const ctx = buildPopupContext(trigger);
        const key = ctx.path + "_" + trigger + "_" + (ctx.isMobile ? "mobile" : "desktop");
        
        const cached = getCachedPopup(key);
        if (cached) {
            return cached;
        }
        
        const deviceContext = ctx.isMobile ? "Mobile user" : "Desktop user";
        const timeContext = ctx.timeOnPage < 10 ? "just arrived" : ctx.timeOnPage < 30 ? "browsing" : "exploring";
        
        const prompt = `Write one short friendly popup message (max 12 words) helping a website visitor.
Context: ${deviceContext} on ${ctx.pageType} page, ${timeContext} for ${ctx.timeOnPage}s
Page title: ${ctx.title}
Trigger: ${trigger}
Guidelines: Be helpful, friendly, concise. Don't mention technical details.`;
        
        try {
            const res = await callAIPopup(prompt, 20);
            const msg = res.trim() || "Need help with something here?";
            setCachedPopup(key, msg);
            return msg;
        } catch (e) {
            return "Need help with something here?";
        }
    }
    
    async function triggerContextualAssistant(trigger) {
        if (!canTriggerPopup()) return;
        const message = await generateContextualAIPopup(trigger);
        showRobotMessage(message);
    }

    async function triggerAssistant(message, overrideText) {
        if (botState.isChatOpen) return;
        if (hasPageTriggered()) return;
        if (!canTriggerPopup()) return;
        var text = overrideText || await generateAIPopup();
        if (!text) return;
        showRobotMessage(message, text);
    }

    function triggerNudge(message, text) {
        if (botState.isChatOpen) return;
        if (!canTriggerPopup()) return;
        showRobotMessage(message, text);
    }

    function setupAIPopupTrigger(message) {
        setTimeout(function () {
            triggerAssistant(message);
        }, 15000);
    }

    function setupEngagementTriggers(message) {
        var idleTimer = null;
        var scrollPromptShown = false;

        function trackInteraction() {
            interactionScore += 1;
            if (interactionScore > 3) {
                getContextualPersonality().then(function(text) {
                    triggerNudge(message, text);
                });
            }
        }

        document.addEventListener("mousemove", function (e) {
            if (e.clientY <= 10) {
                generateContextualAIPopup("exit-intent").then(function(text) {
                    triggerNudge(message, text);
                });
            }
        });

        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden") {
                generateContextualAIPopup("leaving-page").then(function(text) {
                    triggerNudge(message, text);
                });
            }
        });

        window.addEventListener("popstate", function () {
            triggerNudge(message, "Need help before leaving?");
        });

        function resetIdleTimer() {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(function () {
                triggerNudge(message, "Still looking? I can help you find what you need.");
            }, 20000);
        }

        ["mousemove", "scroll", "click", "touchstart", "keydown"].forEach(function (eventName) {
            document.addEventListener(eventName, resetIdleTimer);
        });
        resetIdleTimer();

        ["scroll", "mousemove", "click", "touchstart"].forEach(function (eventName) {
            document.addEventListener(eventName, trackInteraction);
        });

        window.addEventListener("scroll", function () {
            if (scrollPromptShown) return;
            var maxScroll = document.body.scrollHeight - window.innerHeight;
            if (maxScroll <= 0) return;
            var scrollPercent = window.scrollY / maxScroll;
            if (scrollPercent > 0.7) {
                scrollPromptShown = true;
                generateContextualAIPopup("scroll-exploration").then(function(text) {
                    triggerNudge(message, text);
                });
            }
        });
    }

    function setupCursorAwareness(message) {
        botState.cursorX = 0;
        botState.cursorY = 0;
        botState.touchX = 0;
        botState.touchY = 0;
        botState.lastPointerAt = 0;
        botState.stopMovementUntil = 0;
        botState.lastElementProximityAt = 0;

        function getRobotPosition() {
            var container = document.getElementById("anhance-robot-container");
            if (!container) return { x: 0, y: 0 };
            var rect = container.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }

        function getActivePointer() {
            if (isMobileDevice()) {
                return { x: botState.touchX || 0, y: botState.touchY || 0 };
            }
            return { x: botState.cursorX || 0, y: botState.cursorY || 0 };
        }

        function getImportantElements() {
            return document.querySelectorAll("button, .cta, .add-to-cart, .buy-now, .pricing-button, a, .btn, .button, input[type='submit'], input[type='button']");
        }

        function getMessageForElement(el) {
            var text = "";
            try {
                text = (el && el.innerText ? String(el.innerText) : "").toLowerCase();
            } catch (e) {}
            if (el && el.classList && (el.classList.contains("add-to-cart") || el.classList.contains("buy-now"))) {
                return "Need help choosing this product?";
            }
            if (text.includes("add to cart") || text.includes("buy now")) {
                return "Need help choosing this product?";
            }
            if (text.includes("checkout")) {
                return "Need help completing your order?";
            }
            if (text.includes("pricing") || text.includes("plan")) {
                return "Need help picking the right plan?";
            }
            if (text.includes("subscribe") || text.includes("sign up")) {
                return "Need help with subscription?";
            }
            return "Need help with this option?";
        }

        function detectElementProximity() {
            if (botState.isChatOpen) return;
            var now = Date.now();
            if (now - (botState.lastPointerAt || 0) > 6000) return;
            if (now - (botState.lastElementProximityAt || 0) < 4000) return;
            var pointer = getActivePointer();
            if (!pointer.x && !pointer.y) return;
            var elements = getImportantElements();
            for (var i = 0; i < elements.length; i++) {
                var el = elements[i];
                if (!el || !el.getBoundingClientRect) continue;
                var rect = el.getBoundingClientRect();
                var centerX = rect.left + rect.width / 2;
                var centerY = rect.top + rect.height / 2;
                var dx = Math.abs(pointer.x - centerX);
                var dy = Math.abs(pointer.y - centerY);
                if (dx < 120 && dy < 120) {
                    botState.stopMovementUntil = Date.now() + 2000;
                    botState.lastElementProximityAt = now;
                    const trigger = getTriggerTypeForElement(el);
                    triggerContextualAssistant(trigger);
                    return;
                }
            }
        }

        document.addEventListener("mousemove", function (e) {
            botState.cursorX = e.clientX;
            botState.cursorY = e.clientY;
            botState.lastPointerAt = Date.now();
            var target = e.target;
            var pos = getRobotPosition();
            var dist = Math.abs(botState.cursorX - pos.x);
            if (dist < 120) {
                getContextualPersonality().then(function(text) {
                    triggerNudge(message, text);
                });
            }
        });

        document.addEventListener("touchstart", function (e) {
            var t = e.touches && e.touches[0] ? e.touches[0] : null;
            if (!t) return;
            botState.touchX = t.clientX;
            botState.touchY = t.clientY;
            botState.lastPointerAt = Date.now();
        }, { passive: true });

        document.addEventListener("touchmove", function (e) {
            var t = e.touches && e.touches[0] ? e.touches[0] : null;
            if (!t) return;
            botState.touchX = t.clientX;
            botState.touchY = t.clientY;
            botState.lastPointerAt = Date.now();
        }, { passive: true });

        setInterval(detectElementProximity, 1500);
    }

    function classifyPage() {
        var path = (location.pathname || "").toLowerCase();
        if (path.includes("pricing") || document.querySelector("[data-pricing]")) {
            return "pricing";
        }
        if (path.includes("product") || document.querySelector("[data-product]")) {
            return "product";
        }
        if (path.includes("cart") || document.querySelector("[data-cart]")) {
            return "cart";
        }
        if (path.includes("about")) {
            return "about";
        }
        return "general";
    }

    function getPopupForPage(pageType) {
        if (pageType === "product") {
            return triggerContextualAssistant("page-product");
        }
        if (pageType === "pricing") {
            return triggerContextualAssistant("page-pricing");
        }
        if (pageType === "cart") {
            return triggerContextualAssistant("page-cart");
        }
        if (pageType === "about") {
            return triggerContextualAssistant("page-about");
        }
        return triggerContextualAssistant("page-general");
    }

    function onPageChanged(message) {
        if (botState.isChatOpen) return;
        botState.currentPage = classifyPage();
        botState.cursorX = 0;
        botState.cursorY = 0;
        botState.touchX = 0;
        botState.touchY = 0;
        botState.lastPointerAt = 0;
        pageTransitionPause = Date.now() + 1500;
        if (typeof robotX !== 'undefined') {
            robotX = Math.max(20, Math.min((window.innerWidth || 0) - 92, robotX));
        }
        setTimeout(function () {
            triggerAssistant(message, getPopupForPage(botState.currentPage));
        }, 1000);
    }

    function startPageObserver(message) {
        setInterval(function () {
            if (location.href !== botState.lastUrl) {
                botState.lastUrl = location.href;
                onPageChanged(message);
            }
        }, 250);
        onPageChanged(message);
    }

    function setupProductHoverTriggers(message) {
        var productElements = document.querySelectorAll(".product, .product-card, .product-item, [data-product]");
        if (!productElements || productElements.length === 0) return;
        if (!isMobileDevice()) {
            productElements.forEach(function (el) {
                el.addEventListener("mouseenter", function () {
                    if (botState.isChatOpen) return;
                    var nameEl = el.querySelector("h2, h3, .product-title");
                    if (nameEl && nameEl.innerText && nameEl.innerText.trim()) {
                        triggerContextualAssistant("product-specific-interest");
                    } else {
                        triggerContextualAssistant("product-general-interest");
                    }
                });
            });
            return;
        }
        var mobileShown = false;
        window.addEventListener("scroll", function () {
            if (mobileShown || botState.isChatOpen) return;
            productElements.forEach(function (el) {
                var rect = el.getBoundingClientRect();
                if (rect.top < window.innerHeight && rect.bottom > 0) {
                    mobileShown = true;
                    var nameEl = el.querySelector("h2, h3, .product-title");
                    if (nameEl && nameEl.innerText && nameEl.innerText.trim()) {
                        triggerContextualAssistant("product-specific-interest");
                    } else {
                        triggerContextualAssistant("product-general-interest");
                    }
                }
            });
        });
    }

    function setupPricingHesitationTrigger(message) {
        if (!isPricingPage()) return;
        var pricingTimer = setTimeout(function () {
            if (!botState.isChatOpen) {
                triggerContextualAssistant("pricing-hesitation");
            }
        }, 12000);
        ["scroll", "click", "touchstart"].forEach(function (eventName) {
            document.addEventListener(eventName, function () {
                clearTimeout(pricingTimer);
            });
        });
    }

    function setupCartAbandonmentTrigger(message) {
        if (!isCartPage()) return;
        var cartTimer = setTimeout(function () {
            if (!botState.isChatOpen) {
                triggerContextualAssistant("cart-abandonment");
            }
        }, 15000);
        ["scroll", "click", "touchstart", "keydown"].forEach(function (eventName) {
            document.addEventListener(eventName, function () {
                clearTimeout(cartTimer);
            });
        });
    }

    function setupAdvancedBehaviorTriggers(message) {
        var path = (window.location.pathname || "").toLowerCase();
        var isProductPage = path.includes("product");
        if (isProductPage) {
            if (viewedProducts.indexOf(path) === -1) {
                viewedProducts.push(path);
            }
            if (viewedProducts.length >= 3) {
                if (!botState.comparePopupShown) {
                    botState.comparePopupShown = true;
                    triggerNudge(message, "Looks like you're comparing products. Want help choosing?");
                }
            }
        }

        if (isProductPage) {
            var reviewShown = false;
            window.addEventListener("scroll", function () {
                if (reviewShown || botState.isChatOpen) return;
                var maxScroll = document.body.scrollHeight - window.innerHeight;
                if (maxScroll <= 0) return;
                var scrollPercent = window.scrollY / maxScroll;
                if (scrollPercent > 0.7) {
                    reviewShown = true;
                    triggerAssistant(message, "Want to see what other customers say about this product?");
                }
            });
        }

        if (isProductPage) {
            var idleTimer = null;
            var discountShown = false;
            var resetIdle = function () {
                if (idleTimer) {
                    clearTimeout(idleTimer);
                }
                idleTimer = setTimeout(function () {
                    if (!discountShown) {
                        discountShown = true;
                        triggerAssistant(message, "Looking for a deal? I can check if there's a discount available.");
                    }
                }, 15000);
            };
            ["mousemove", "scroll", "click", "touchstart"].forEach(function (eventName) {
                document.addEventListener(eventName, resetIdle);
            });
            resetIdle();
        }

        if (!isMobileDevice()) {
            var exitShown = false;
            document.addEventListener("mouseout", function (e) {
                if (exitShown) return;
                if (e.clientY <= 0) {
                    exitShown = true;
                    triggerAssistant(message, "Before you leave, want help finding the right product?");
                }
            });
        } else {
            var mobileExitShown = false;
            window.addEventListener("beforeunload", function () {
                if (mobileExitShown) return;
                mobileExitShown = true;
                generateContextualAIPopup("leaving-page").then(function(text) {
                    triggerAssistant(message, text);
                });
            });
        }

        try {
            var returningVisitor = localStorage.getItem("anhance-returning");
            if (!returningVisitor) {
                localStorage.setItem("anhance-returning", "true");
            } else {
                setTimeout(function () {
                    triggerAssistant(message, "Welcome back! Need help finding something today?");
                }, 8000);
            }
        } catch (e) {}
    }

    function setupRobotBehavior(robot, message) {
        var idleTimer = null;
        var scrollTriggered = false;
        var exitIntentCooldown = false;
        var robotDirection = 1;
        var robotX = 20;
        var isPaused = false;
        var pageTransitionPause = 0;

        function resetIdleTimer() {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            var delay = 15000 + Math.floor(Math.random() * 5001);
            idleTimer = setTimeout(function () {
                showContextPopup(message);
            }, delay);
        }

        function animateRobot() {
            var screenWidth = window.innerWidth || 0;
            var robotWidth = robot.offsetWidth || 72;
            var now = Date.now();
            var stopUntil = botState.stopMovementUntil || 0;
            
            if (!isPaused && now >= stopUntil && now >= pageTransitionPause) {
                var speed = isMobileDevice() ? 0.5 : 1.2;
                var pointerX = 0;
                if (isMobileDevice()) {
                    pointerX = botState.touchX || 0;
                } else {
                    pointerX = botState.cursorX || 0;
                }
                var hasRecentPointer = (botState.lastPointerAt || 0) > 0 && (now - (botState.lastPointerAt || 0) < 6000);
                var targetX = null;
                if (hasRecentPointer && pointerX > 0) {
                    targetX = pointerX - robotWidth / 2;
                }
                if (targetX !== null) {
                    var clamped = Math.max(20, Math.min(screenWidth - robotWidth - 20, targetX));
                    var dx = clamped - robotX;
                    if (Math.abs(dx) >= 80) {
                        var step = Math.sign(dx) * speed * 0.7;
                        robotX += step;
                        robot.classList.remove("robot-flip");
                        if (dx < 0) {
                            robot.classList.add("robot-left");
                        } else {
                            robot.classList.remove("robot-left");
                        }
                    }
                } else {
                    robotX += robotDirection * speed;
                    if (robotX + robotWidth >= screenWidth - 20) {
                        robotDirection = -1;
                        robot.classList.add("robot-flip");
                    }
                    if (robotX <= 20) {
                        robotDirection = 1;
                        robot.classList.remove("robot-flip");
                    }
                }
                updateMessagePosition(message, robotX, robotWidth);
            }
            requestAnimationFrame(animateRobot);
        }

        function schedulePause() {
            var interval = 15000 + Math.floor(Math.random() * 5001);
            setTimeout(function () {
                isPaused = true;
                showContextPopup(message);
                setTimeout(function () {
                    isPaused = false;
                    schedulePause();
                }, 2000);
            }, interval);
        }

        document.addEventListener("mousemove", resetIdleTimer);
        document.addEventListener("scroll", resetIdleTimer);
        document.addEventListener("keydown", resetIdleTimer);
        resetIdleTimer();

        document.addEventListener("mouseout", function (e) {
            if (e.clientY <= 0 && !exitIntentCooldown) {
                exitIntentCooldown = true;
                showContextPopup(message);
                setTimeout(function () {
                    exitIntentCooldown = false;
                }, 15000);
            }
        });

        window.addEventListener("scroll", function () {
            if (!scrollTriggered && window.scrollY > window.innerHeight * 0.6) {
                scrollTriggered = true;
                showContextPopup(message);
            }
        });

        animateRobot();
        schedulePause();
    }

    function boot() {
        if (window.__anhanceChatWidgetBooted) return;
        window.__anhanceChatWidgetBooted = true;

        injectRobotStyles();
        var robot = createRobotWidget();
        var message = createRobotMessage();
        var frame = createChatFrame();

        updateMessagePosition(message, 20, 72);
        setupMessageBridge(robot, frame, message);
        setupRobotBehavior(robot, message);
        setupProductHoverTriggers(message);
        setupPricingHesitationTrigger(message);
        setupCartAbandonmentTrigger(message);
        setupAdvancedBehaviorTriggers(message);
        setupAIPopupTrigger(message);
        setupEngagementTriggers(message);
        startPageObserver(message);
        setupCursorAwareness(message);

        robot.addEventListener("click", function () {
            showChat(robot, frame, message);
        });

        frame.addEventListener("load", function () {
            if (frame.dataset.openRequested === "true") {
                postToFrame(frame, { type: "anhanceChat-toggle", visible: true });
                delete frame.dataset.openRequested;
            }
        });

        setTimeout(function() {
            startInteractionEngine();
        }, 1000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
