window.term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    theme: { background: '#0a0a0a', foreground: '#ededed' },
    scrollback: 10000,
    allowTransparency: false,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();

const statusDot = document.getElementById('status-dot');
const input = document.getElementById('input');
const scrollBtn = document.getElementById('scroll-to-bottom');
const specialKeysBtn = document.getElementById('special-keys-btn');
const specialKeysPopup = document.getElementById('special-keys-popup');

let ws = null;
let pendingInputs = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let reconnectTimeoutId = null;
let isReconnecting = false;
let isUserScrolling = false;

// Touch scrolling state
const terminalContainer = document.getElementById('terminal-container');
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// Initialize touch scrolling for mobile devices
if (isTouchDevice) {
    initTouchScrolling(terminalContainer, () => { isUserScrolling = true; });
}

// Touch scrolling implementation for smooth mobile scrolling
function initTouchScrolling(container, onScrollStart) {
    const touchState = {
        startY: 0, lastY: 0, lastTime: 0,
        velocity: 0, identifier: null,
        touching: false, velocityHistory: [],
        accumulator: 0, inertiaId: null
    };

    // Create touch overlay
    const overlay = createTouchOverlay(container);

    // Attach event handlers
    overlay.addEventListener('touchstart', handleTouchStart, { passive: false });
    overlay.addEventListener('touchmove', handleTouchMove, { passive: false });
    overlay.addEventListener('touchend', handleTouchEnd, { passive: false });
    overlay.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    // Prevent conflicts with input area
    const inputArea = document.getElementById('input-area');
    if (inputArea) {
        inputArea.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    }

    function createTouchOverlay(parent) {
        const div = document.createElement('div');
        Object.assign(div.style, {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
            zIndex: '1', touchAction: 'none', webkitTouchCallout: 'none',
            webkitUserSelect: 'none', userSelect: 'none', pointerEvents: 'auto'
        });
        parent.appendChild(div);
        return div;
    }

    function performScroll(deltaY) {
        const viewport = container.querySelector('.xterm-viewport');
        if (!viewport) return;
        viewport.scrollTop += deltaY;
        viewport.dispatchEvent(new WheelEvent('wheel', {
            deltaY, deltaMode: 0, bubbles: true, cancelable: true
        }));
    }

    function handleTouchStart(e) {
        e.preventDefault();
        cancelInertia();
        touchState.accumulator = 0;

        if (e.touches.length > 0) {
            const touch = e.touches[0];
            Object.assign(touchState, {
                identifier: touch.identifier,
                startY: touch.clientY,
                lastY: touch.clientY,
                lastTime: performance.now(),
                velocity: 0,
                velocityHistory: [],
                touching: true
            });
            onScrollStart();
        }
    }

    function handleTouchMove(e) {
        e.preventDefault();
        if (!touchState.touching || e.touches.length === 0) return;

        const touch = findTrackedTouch(e.touches) || e.touches[0];
        const currentY = touch.clientY;
        const deltaY = touchState.lastY - currentY;
        const currentTime = performance.now();
        const timeDelta = Math.max(1, currentTime - touchState.lastTime);

        // Update velocity
        updateVelocity(deltaY / timeDelta);

        touchState.lastY = currentY;
        touchState.lastTime = currentTime;
        touchState.accumulator += deltaY;

        // Apply scroll when threshold reached
        if (Math.abs(touchState.accumulator) >= 0.5) {
            performScroll(touchState.accumulator * 1.8);
            touchState.accumulator = touchState.accumulator % 0.5;
        }
    }

    function handleTouchEnd(e) {
        e.preventDefault();
        if (!isTouchEnded(e.touches)) return;

        touchState.touching = false;
        touchState.identifier = null;

        // Apply remaining scroll
        if (Math.abs(touchState.accumulator) > 0) {
            performScroll(touchState.accumulator * 1.8);
            touchState.accumulator = 0;
        }

        // Start inertia if needed
        if (Math.abs(touchState.velocity) > 0.01) {
            startInertia();
        }
    }

    function handleTouchCancel(e) {
        e.preventDefault();
        resetTouchState();
        cancelInertia();
    }

    function findTrackedTouch(touches) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === touchState.identifier) {
                return touches[i];
            }
        }
        return null;
    }

    function isTouchEnded(touches) {
        return !findTrackedTouch(touches);
    }

    function updateVelocity(instant) {
        touchState.velocityHistory.push(instant);
        if (touchState.velocityHistory.length > 5) {
            touchState.velocityHistory.shift();
        }

        // Calculate weighted average
        let weightedSum = 0, totalWeight = 0;
        touchState.velocityHistory.forEach((v, i) => {
            const weight = i + 1;
            weightedSum += v * weight;
            totalWeight += weight;
        });
        touchState.velocity = totalWeight ? weightedSum / totalWeight : 0;
    }

    function startInertia() {
        const friction = 0.95;
        const minVelocity = 0.01;

        function animate() {
            if (Math.abs(touchState.velocity) < minVelocity || touchState.touching) {
                touchState.inertiaId = null;
                touchState.velocity = 0;
                return;
            }

            performScroll(touchState.velocity * 25);
            touchState.velocity *= friction;
            touchState.inertiaId = requestAnimationFrame(animate);
        }
        animate();
    }

    function cancelInertia() {
        if (touchState.inertiaId) {
            cancelAnimationFrame(touchState.inertiaId);
            touchState.inertiaId = null;
        }
    }

    function resetTouchState() {
        Object.assign(touchState, {
            touching: false, identifier: null,
            velocity: 0, velocityHistory: [],
            accumulator: 0
        });
    }
}

function setInputEnabled(enabled) {
    input.disabled = !enabled;
    input.style.opacity = enabled ? '1' : '0.5';
    input.style.cursor = enabled ? 'text' : 'not-allowed';
    if (!enabled) {
        input.placeholder = 'Reconnecting...';
    } else {
        input.placeholder = 'Type command or use voice input...';
    }
}

function updateStatus(state) {
    statusDot.className = '';
    if (state === 'disconnected') {
        statusDot.classList.add('disconnected');
        isReconnecting = true;
    } else if (state === 'connecting') {
        statusDot.classList.add('connecting');
        isReconnecting = true;
    } else if (state === 'connected') {
        isReconnecting = false;
    }
}

function connect() {
    // WebSocket will automatically include cookies with the request
    // Build WebSocket URL relative to current location
    // Remove any trailing slash from pathname
    const basePath = location.pathname.replace(/\/$/, '');
    const wsUrl = location.protocol.replace('http', 'ws') + '//' + location.host + basePath + '/ws';

    // For debugging - log if auth cookie exists
    const hasCookie = document.cookie.includes('auth=');
    console.log('Connecting WebSocket, auth cookie present:', hasCookie);

    ws = new WebSocket(wsUrl);

    // Expose WebSocket globally for voice input
    window.terminalWs = ws;

    ws.onopen = () => {
        console.log('WebSocket connected');
        updateStatus('connected');
        reconnectAttempts = 0;
        fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onclose = () => {
        console.log('WebSocket closed');
        updateStatus('disconnected');
        ws = null;
        window.terminalWs = null;
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            reconnectTimeoutId = setTimeout(() => {
                connect();
            }, 500);
        } else {
            setInputEnabled(false);
            input.placeholder = 'Connection failed. Refresh page.';
        }
    };

    ws.onerror = (err) => {
        console.log('WebSocket error');
    };

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
            term.write(msg.data);
            checkScrollPosition();
        }
        if (msg.type === 'history') {
            term.clear();
            msg.data.forEach(d => term.write(d));
            setInputEnabled(true);
            term.scrollToBottom();
            setTimeout(() => {
                const viewport = document.querySelector('.xterm-viewport');
                if (viewport) {
                    viewport.scrollTop = viewport.scrollHeight;
                }
                isUserScrolling = false;
            }, 100);
        }
        // Handle ASR messages
        if (msg.type === 'asr_response') {
            if (window.handleASRResponse) {
                window.handleASRResponse(msg.data);
            }
        }
        // Handle Claude response messages
        if (msg.type === 'claude_response') {
            if (window.voiceInput) {
                if (msg.data.error) {
                    console.error('[Claude] Server error:', msg.data.error);
                    // Fallback to original transcript if available
                    if (msg.data.fallback) {
                        // Restore existing content and append fallback
                        const existingContent = window.voiceInput.existingInputContent || '';
                        const needSpace = existingContent && !existingContent.endsWith(' ');
                        input.value = existingContent + (needSpace ? ' ' : '') + msg.data.fallback;
                        input.style.height = 'auto';
                        input.style.height = input.scrollHeight + 'px';
                    }
                } else if (msg.data.text) {
                    // First chunk: restore existing content
                    if (input.value === '' && window.voiceInput.existingInputContent) {
                        const existingContent = window.voiceInput.existingInputContent;
                        const needSpace = existingContent && !existingContent.endsWith(' ');
                        input.value = existingContent + (needSpace ? ' ' : '');
                        // Clear the flag so we don't add it again
                        window.voiceInput.existingInputContent = '';
                    }
                    // Stream text to input
                    input.value += msg.data.text;
                    input.style.height = 'auto';
                    input.style.height = input.scrollHeight + 'px';
                } else if (msg.data.done) {
                    console.log('[Claude] Processing complete');
                    // Clear the existing content flag
                    if (window.voiceInput) {
                        window.voiceInput.existingInputContent = '';

                        // Check if auto-submit is pending (triggered by "go go go" command)
                        if (window.voiceInput.autoSubmitPending) {
                            console.log('[Claude] Auto-submit triggered by "go go go" command');
                            window.voiceInput.autoSubmitPending = false;

                            // Auto-submit the command after a short delay to ensure input is updated
                            setTimeout(() => {
                                const cmd = input.value.trim();
                                if (cmd && ws && ws.readyState === 1) {
                                    input.value = '';
                                    input.style.height = 'auto';
                                    // Send text first, then Enter key
                                    ws.send(JSON.stringify({ type: 'input', data: cmd }));
                                    setTimeout(() => {
                                        ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(13) }));
                                    }, 50);
                                }
                            }, 100);
                        }
                    }
                }
            }
        }
    };
}

// Input handling - must send text and Enter key separately for Claude Code to work
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ws && ws.readyState === 1) {
            const cmd = input.value;
            input.value = '';
            input.style.height = 'auto';
            if (cmd) {
                // Send text first, then Enter key separately after delay
                ws.send(JSON.stringify({ type: 'input', data: cmd }));
                setTimeout(() => {
                    ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(13) }));
                }, 50);
            } else {
                // Just send Enter if empty
                ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(13) }));
            }
        }
    }
});

// Auto-resize textarea
input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
});

// Special keys handling
specialKeysBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    specialKeysPopup.classList.toggle('show');
});

document.addEventListener('click', (e) => {
    if (!specialKeysPopup.contains(e.target) && e.target !== specialKeysBtn) {
        specialKeysPopup.classList.remove('show');
    }
});

document.querySelectorAll('.special-key').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        handleSpecialKey(key);
        specialKeysPopup.classList.remove('show');
    });
});

function handleSpecialKey(key) {
    if (!ws || ws.readyState !== 1) return;

    const keyMap = {
        'Escape': '\x1b',
        'Tab': '\t',
        'Up': '\x1b[A',
        'Down': '\x1b[B',
        'Left': '\x1b[D',
        'Right': '\x1b[C',
        'Ctrl+C': '\x03',
        'Ctrl+D': '\x04',
        'Ctrl+Z': '\x1a',
        'Ctrl+L': '\x0c',
        'Home': '\x1b[H',
        'End': '\x1b[F',
        'PageUp': '\x1b[5~',
        'PageDown': '\x1b[6~',
        'F1': '\x1bOP',
        'F2': '\x1bOQ',
        'F3': '\x1bOR',
        'F4': '\x1bOS'
    };

    if (keyMap[key]) {
        ws.send(JSON.stringify({ type: 'input', data: keyMap[key] }));
    }
}

// Scroll handling
function checkScrollPosition() {
    const viewport = document.querySelector('.xterm-viewport');
    if (!viewport) return;

    const isNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;

    if (isNearBottom) {
        scrollBtn.classList.remove('visible');
        isUserScrolling = false;
    } else {
        scrollBtn.classList.add('visible');
    }
}

scrollBtn.addEventListener('click', () => {
    const viewport = document.querySelector('.xterm-viewport');
    if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
    }
    term.scrollToBottom();
    isUserScrolling = false;
    scrollBtn.classList.remove('visible');
});

// Monitor scroll
const viewport = document.querySelector('.xterm-viewport');
if (viewport) {
    viewport.addEventListener('scroll', () => {
        checkScrollPosition();
    });
}

// Window resize
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        fitAddon.fit();
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
    }, 100);
});

// Debug console controls
const contextLengthInput = document.getElementById('context-length');

// Update context length when changed
if (contextLengthInput) {
    contextLengthInput.addEventListener('change', () => {
        const length = parseInt(contextLengthInput.value);
        if (window.terminalASR) {
            window.terminalASR.setMaxContextLength(length);
        }
    });
}

// Get terminal context function (kept for other uses)
function getTerminalContext() {
    if (window.term) {
        const buffer = window.term.buffer.active;
        const lines = [];
        for (let i = Math.max(0, buffer.length - 50); i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }
        return lines;
    }
    return [];
}

// Initial connection
connect();
