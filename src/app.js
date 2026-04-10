import { CreateMLCEngine } from "@mlc-ai/web-llm";
import mermaid from "mermaid";

// Mermaid Initialization
mermaid.initialize({ startOnLoad: false, theme: 'dark' });

// Lucide Icons Initialization
lucide.createIcons();

// --- State Variables ---
let isRecording = false;
let isProcessingAI = false;
let timerInterval, startTime;
let mediaRecorder = null, audioChunks = [], currentAudioBlob = null;
let finalTranscript = '', interimTranscript = '', recognition = null, wakeLock = null;
let currentSessionMap = new Map(); 
let db = null; 
let currentSessionId = null;

// WebLLM Engine
let engine = null;

// --- IndexedDB Initialization (Audio & Session Backup) ---
const dbReq = indexedDB.open("LocalAIAssistantDB", 2);
dbReq.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('backups')) {
        db.createObjectStore('backups', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
    }
};
dbReq.onsuccess = (e) => {
    db = e.target.result;
    checkRecovery();
    loadHistory();
};

function checkRecovery() {
    const savedText = localStorage.getItem('local_ai_assistant_text');
    if (savedText) {
        finalTranscript = savedText;
        updateTranscriptionUI();
    }
    if (db) {
        const tx = db.transaction('backups', 'readonly');
        const getReq = tx.objectStore('backups').get('latest_audio');
        getReq.onsuccess = (e) => {
            if (e.target.result && e.target.result.blob) {
                currentAudioBlob = e.target.result.blob;
                document.getElementById('downloadAudioBtn').disabled = false;
            }
        };
    }
}

// --- DOM Elements & Event Listeners ---
window.addEventListener('DOMContentLoaded', async () => {
    initApp();
    
    // Device detection for default model (Move here to use in splash)
    const savedModel = localStorage.getItem('webllm_model');
    if (savedModel) {
        document.getElementById('modelNameInput').value = savedModel;
    } else {
        // Default to the lightest model for everyone to prevent crashes and ensure speed
        document.getElementById('modelNameInput').value = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
    }

    // Start Splash & Engine Pre-init
    document.getElementById('splashChangeModelBtn').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
        document.getElementById('settingsModal').style.zIndex = "200"; // Ensure it's above splash
    });

    await startSplashAndInit();

    // Buttons
    document.getElementById('recBtn').addEventListener('click', toggleRecording);
    document.getElementById('refreshMicBtn').addEventListener('click', updateMicList);
    document.getElementById('downloadAudioBtn').addEventListener('click', () => handleSave(currentAudioBlob, '.mp3', 'MP3音声データ'));
    document.getElementById('downloadTransBtn').addEventListener('click', () => {
        const blob = new Blob([finalTranscript], { type: 'text/plain' });
        handleSave(blob, '.txt', '文字起こしデータ');
    });
    document.getElementById('generateBtn').addEventListener('click', generateSummary);
    
    // Copy AI Result
    document.getElementById('copyAiBtn').addEventListener('click', () => {
        const text = document.getElementById('summaryDisplay').innerText;
        if(text) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copyAiBtn');
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="check" class="w-4 h-4 text-green-400"></i>';
                lucide.createIcons();
                setTimeout(() => { btn.innerHTML = originalHtml; lucide.createIcons(); }, 2000);
            });
        }
    });

    // Settings
    document.getElementById('settingsBtn').addEventListener('click', () => document.getElementById('settingsModal').classList.remove('hidden'));
    document.getElementById('closeSettingsBtn').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

    // Sidebar & Tasks
    document.getElementById('toggleSidebarBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('-translate-x-full');
    });
    document.getElementById('closeSidebarBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.add('-translate-x-full');
    });
    document.getElementById('showTasksBtn').addEventListener('click', () => {
        document.getElementById('taskSelectionOverlay').classList.remove('-translate-y-full');
    });
    document.getElementById('hideTasksBtn').addEventListener('click', () => {
        document.getElementById('taskSelectionOverlay').classList.add('-translate-y-full');
    });
    document.getElementById('newSessionBtn').addEventListener('click', startNewSession);
    document.getElementById('downloadTextBtn').addEventListener('click', downloadAiOutput);

    // Load Settings
    // (Already handled in DOMContentLoaded for splash)

    // Clear Data
    document.getElementById('clearDataBtn').addEventListener('click', () => {
        if(confirm("⚠️ 記録された音声とテキストデータをすべて消去しますか？\n（復元できなくなります）")) {
            finalTranscript = ''; interimTranscript = ''; currentSessionMap.clear();
            currentAudioBlob = null;
            localStorage.removeItem('local_ai_assistant_text');
            if (db) {
                const tx = db.transaction('backups', 'readwrite');
                tx.objectStore('backups').delete('latest_audio');
            }
            updateTranscriptionUI();
            document.getElementById('transcriptionDisplay').innerText = '';
            document.getElementById('transcriptionPlaceholder').style.display = 'flex';
            document.getElementById('downloadAudioBtn').disabled = true;
            document.getElementById('downloadTransBtn').disabled = true;
            
            document.getElementById('summaryDisplay').style.display = 'none';
            document.getElementById('summaryPlaceholder').style.display = 'flex';
            document.getElementById('copyAiBtn').classList.add('hidden');
            document.getElementById('timerDisplay').innerText = '00:00:00';
        }
    });

    // Prevent accidental close
    window.addEventListener('beforeunload', (e) => {
        if (isRecording || isProcessingAI) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    document.addEventListener('visibilitychange', async () => {
        if (wakeLock !== null && document.visibilityState === 'visible' && isRecording) await requestWakeLock();
    });
});

function saveSettings() {
    localStorage.setItem('webllm_model', document.getElementById('modelNameInput').value);
    document.getElementById('settingsModal').classList.add('hidden');
    
    // If splash is visible, reload to apply new model
    if (document.getElementById('splashScreen')) {
        location.reload();
    }
}

// --- History & Session Management ---
async function loadHistory() {
    if (!db) return;
    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    const request = store.getAll();

    request.onsuccess = () => {
        const sessions = request.result.sort((a, b) => b.timestamp - a.timestamp);
        const list = document.getElementById('historyList');
        list.innerHTML = '';

        if (sessions.length === 0) {
            list.innerHTML = '<div class="text-center py-10 text-slate-600 text-xs italic">保存されたデータはありません</div>';
            return;
        }

        let totalSize = 0;
        sessions.forEach(session => {
            const item = document.createElement('button');
            item.className = `w-full text-left p-3 rounded-md transition flex flex-col gap-1 group ${currentSessionId === session.id ? 'bg-blue-900/40 border border-blue-800/50' : 'hover:bg-slate-900 border border-transparent'}`;
            
            const date = new Date(session.timestamp).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const title = session.title || '無題のセッション';
            
            item.innerHTML = `
                <div class="flex justify-between items-start">
                    <span class="text-xs font-bold text-slate-200 truncate pr-2">${title}</span>
                    <span class="text-[10px] text-slate-500 shrink-0">${date}</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-[10px] text-slate-500 truncate">${session.text.substring(0, 30)}...</span>
                    <button class="delete-session-btn opacity-0 group-hover:opacity-100 p-1 text-slate-600 hover:text-red-400 transition" data-id="${session.id}">
                        <i data-lucide="trash-2" class="w-3 h-3"></i>
                    </button>
                </div>
            `;
            
            item.addEventListener('click', (e) => {
                if (e.target.closest('.delete-session-btn')) {
                    deleteSession(session.id);
                } else {
                    loadSession(session.id);
                }
            });
            list.appendChild(item);
            
            // Estimate size
            totalSize += (session.text.length * 2) + (session.audioBlob ? session.audioBlob.size : 0);
        });
        
        lucide.createIcons();
        updateStorageUsage(totalSize);
    };
}

async function saveSession() {
    if (!db || (!finalTranscript && currentSessionMap.size === 0)) return;
    
    // Commit any pending results before saving
    let sessionText = '';
    for (let [index, item] of currentSessionMap.entries()) {
        sessionText += `[${item.time}] ${item.text}\n`;
    }
    const fullTextToSave = finalTranscript + sessionText;

    // Generate a cleaner title by stripping timestamps
    let cleanTitle = fullTextToSave.replace(/\[\d{2}:\d{2}:\d{2}\]\s*/g, '').substring(0, 30).trim() || '新規セッション';
    if (cleanTitle.length >= 30) cleanTitle += '...';

    const sessionData = {
        timestamp: Date.now(),
        title: cleanTitle,
        text: fullTextToSave,
        audioBlob: currentAudioBlob,
        aiResults: document.getElementById('summaryDisplay').innerHTML,
        hasAi: !document.getElementById('summaryDisplay').classList.contains('hidden')
    };

    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    
    if (currentSessionId) {
        sessionData.id = currentSessionId;
        store.put(sessionData);
    } else {
        const addReq = store.add(sessionData);
        addReq.onsuccess = (e) => {
            currentSessionId = e.target.result;
            loadHistory();
        };
    }
    
    tx.oncomplete = () => loadHistory();
}

async function loadSession(id) {
    if (!db) return;
    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    const request = store.get(id);

    request.onsuccess = () => {
        const session = request.result;
        if (!session) return;

        currentSessionId = session.id;
        finalTranscript = session.text;
        currentAudioBlob = session.audioBlob;
        
        updateTranscriptionUI();
        
        const summaryDisplay = document.getElementById('summaryDisplay');
        const summaryPlaceholder = document.getElementById('summaryPlaceholder');
        
        if (session.hasAi) {
            summaryDisplay.innerHTML = session.aiResults;
            summaryDisplay.classList.remove('hidden');
            summaryPlaceholder.classList.add('hidden');
            document.getElementById('copyAiBtn').classList.remove('hidden');
            document.getElementById('downloadTextBtn').classList.remove('hidden');
            
            // Re-render Mermaid if present
            const mermaidDivs = summaryDisplay.querySelectorAll('.mermaid');
            mermaidDivs.forEach(div => {
                const code = div.getAttribute('data-code');
                if (code) {
                    div.removeAttribute('data-processed');
                    div.innerHTML = code;
                }
            });
            mermaid.run();
        } else {
            summaryDisplay.classList.add('hidden');
            summaryPlaceholder.classList.remove('hidden');
            document.getElementById('copyAiBtn').classList.add('hidden');
            document.getElementById('downloadTextBtn').classList.add('hidden');
        }
        
        document.getElementById('downloadAudioBtn').disabled = !currentAudioBlob;
        document.getElementById('downloadTransBtn').disabled = !finalTranscript;
        loadHistory();
        
        // Close sidebar on mobile
        if (window.innerWidth < 1024) {
            document.getElementById('sidebar').classList.add('-translate-x-full');
        }
    };
}

async function deleteSession(id) {
    if (!confirm("このセッションを削除しますか？")) return;
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(id);
    tx.oncomplete = () => {
        if (currentSessionId === id) startNewSession();
        loadHistory();
    };
}

function startNewSession() {
    currentSessionId = null;
    finalTranscript = '';
    interimTranscript = '';
    currentAudioBlob = null;
    currentSessionMap.clear();
    
    updateTranscriptionUI();
    document.getElementById('transcriptionPlaceholder').style.display = 'flex';
    document.getElementById('summaryDisplay').classList.add('hidden');
    document.getElementById('summaryPlaceholder').classList.remove('hidden');
    document.getElementById('copyAiBtn').classList.add('hidden');
    document.getElementById('downloadTextBtn').classList.add('hidden');
    document.getElementById('downloadAudioBtn').disabled = true;
    document.getElementById('downloadTransBtn').disabled = true;
    document.getElementById('timerDisplay').innerText = '00:00:00';
    
    loadHistory();
}

function updateStorageUsage(bytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    document.getElementById('storageUsageText').innerText = `${mb} MB`;
    const percent = Math.min(100, (bytes / (50 * 1024 * 1024)) * 100); // 50MB limit for bar
    document.getElementById('storageUsageBar').style.width = `${percent}%`;
}

// --- Splash & Pre-init Logic ---
async function startSplashAndInit() {
    const splashScreen = document.getElementById('splashScreen');
    const splashLoadingArea = document.getElementById('splashLoadingArea');
    const splashProgressBar = document.getElementById('splashProgressBar');
    const splashStatusText = document.getElementById('splashStatusText');
    const splashPercentText = document.getElementById('splashPercentText');
    const splashSubtext = document.getElementById('splashSubtext');
    const splashTimeRemaining = document.getElementById('splashTimeRemaining');
    const splashChangeModelBtn = document.getElementById('splashChangeModelBtn');

    // 3 second minimum timer
    const minTimer = new Promise(resolve => setTimeout(resolve, 3000));

    const modelName = document.getElementById('modelNameInput').value;
    
    let downloadStartTime = null;
    let lastProgress = 0;

    const initProgressCallback = (initProgress) => {
        // If progress is less than 1, it's likely downloading or doing heavy work
        if (initProgress.progress < 1) {
            splashLoadingArea.classList.remove('opacity-0');
            splashSubtext.innerText = "AIモデルを準備中（初回は数分かかります）...";
            
            if (downloadStartTime === null) {
                downloadStartTime = Date.now();
            }

            // Estimate time remaining
            const currentTime = Date.now();
            const elapsedSeconds = (currentTime - downloadStartTime) / 1000;
            
            if (initProgress.progress > 0 && elapsedSeconds > 1) {
                const totalEstimatedSeconds = elapsedSeconds / initProgress.progress;
                const remainingSeconds = Math.max(0, totalEstimatedSeconds - elapsedSeconds);
                
                if (remainingSeconds > 60) {
                    const mins = Math.floor(remainingSeconds / 60);
                    const secs = Math.floor(remainingSeconds % 60);
                    splashTimeRemaining.innerText = `残り約 ${mins}分 ${secs}秒`;
                } else {
                    splashTimeRemaining.innerText = `残り約 ${Math.floor(remainingSeconds)}秒`;
                }
            }
        } else {
            splashTimeRemaining.innerText = "";
        }
        
        const percent = Math.round(initProgress.progress * 100);
        splashProgressBar.style.width = `${percent}%`;
        splashPercentText.innerText = `${percent}%`;
        
        if (percent === 100) {
            splashStatusText.innerText = "GPUメモリへ展開中... (数秒かかります)";
        } else {
            splashStatusText.innerText = initProgress.text;
        }
    };

    try {
        // Mark as loading to detect crashes
        const crashKey = `crash_detect_${modelName}`;
        const loadCount = parseInt(localStorage.getItem(crashKey) || "0");
        
        if (loadCount > 0) {
            splashSubtext.innerText = "前回の起動時にクラッシュした可能性があります。より軽量なモデル（Llama 3.2 1Bなど）への変更を推奨します。";
            splashLoadingArea.classList.remove('opacity-0');
            splashChangeModelBtn.classList.add('animate-bounce', 'text-blue-400', 'border-blue-400');
        }
        
        localStorage.setItem(crashKey, (loadCount + 1).toString());

        // Initialize engine with limited context window to save memory
        engine = await CreateMLCEngine(modelName, { 
            initProgressCallback,
            chatOpts: {
                context_window_size: 2048 // Limit context to prevent OOM
            }
        });
        engine.activeModel = modelName;
        
        // Success! Clear crash count
        localStorage.removeItem(crashKey);
        
        // Wait for the 3s timer
        await minTimer;
        
        // Hide splash
        splashScreen.classList.add('opacity-0');
        setTimeout(() => splashScreen.remove(), 700);
    } catch (err) {
        console.error("Splash Init Error:", err);
        splashStatusText.innerText = "WebGPUの初期化に失敗しました。";
        splashSubtext.innerText = "お使いのブラウザがWebGPUをサポートしているか確認してください。";
        await minTimer;
        splashScreen.classList.add('opacity-0');
        setTimeout(() => splashScreen.remove(), 700);
    }
}

// --- App Initialization ---
function initApp() {
    updateMicList();
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = 'ja-JP'; 
        recognition.continuous = true; 
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        
        recognition.onerror = (event) => {
            console.warn("SpeechRecognition error:", event.error);
            if (event.error === 'not-allowed' || event.error === 'audio-capture') {
                showError("ERR: マイクへのアクセスが拒否されたか、利用できません。");
                if(isRecording) toggleRecording(); // Stop UI
            }
        };

        recognition.onresult = (event) => {
            let interim = '';
            const currentTime = document.getElementById('timerDisplay').innerText;

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const res = event.results[i];
                if (res.isFinal) {
                    const text = res[0].transcript;
                    finalTranscript += `[${currentTime}] ${text}\n`;
                    localStorage.setItem('local_ai_assistant_text', finalTranscript);
                } else {
                    interim += res[0].transcript;
                }
            }
            interimTranscript = interim;
            updateTranscriptionUI();
        };

        recognition.onend = () => { 
            if (isRecording) { 
                // Restart recognition to overcome timeout
                setTimeout(() => {
                    if (isRecording) {
                        try { recognition.start(); } catch (e) {} 
                    }
                }, 300);
            } 
        };
    } else {
        showError("ERR: このブラウザは音声認識をサポートしていません。Chromeをご利用ください。");
        document.getElementById('recBtn').disabled = true;
    }
}

async function updateMicList() {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        const select = document.getElementById('micSelect');
        select.innerHTML = '<option value="">システム標準マイク</option>';
        audioInputs.forEach(device => {
            if (device.deviceId !== 'default' && device.deviceId !== 'communications') {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `マイク ${select.length}`;
                select.appendChild(option);
            }
        });
    } catch (err) { console.warn("マイク一覧取得失敗:", err); }
}

async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().then(()=>wakeLock=null).catch(()=>{}); } }
function showError(msg) { 
    document.getElementById('sysErrorArea').classList.remove('hidden'); 
    document.getElementById('sysErrorText').innerText = msg; 
}

// --- Recording Logic ---
async function toggleRecording() {
    const recBtn = document.getElementById('recBtn');
    const recBtnText = document.getElementById('recBtnText');
    const micSelect = document.getElementById('micSelect');
    const recIndicator = document.getElementById('recIndicator');

    if (isRecording) {
        // Stop Recording
        isRecording = false; clearInterval(timerInterval); releaseWakeLock();
        
        recBtn.classList.remove('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
        recBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
        recBtn.innerHTML = '<i data-lucide="mic" class="w-4 h-4"></i> <span>録音開始</span>';
        recIndicator.classList.remove('bg-red-500', 'animate-pulse');
        recIndicator.classList.add('bg-slate-600');
        lucide.createIcons();
        
        micSelect.disabled = false;
        
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop(); mediaRecorder.stream.getTracks().forEach(t => t.stop());
        }
        if (recognition) {
            try { recognition.stop(); } catch(e){}
            
            if (interimTranscript) {
                finalTranscript += `[${document.getElementById('timerDisplay').innerText}] ${interimTranscript}\n`;
                interimTranscript = ''; 
            }
            updateTranscriptionUI();
            saveSession();
        }

        setTimeout(() => {
            if(audioChunks.length > 0) {
                currentAudioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
                document.getElementById('downloadAudioBtn').disabled = false;
            }
        }, 200);

    } else {
        // Start Recording
        try {
            const selectedMicId = micSelect.value;
            let audioConstraints = true;
            if (selectedMicId) {
                audioConstraints = { deviceId: { exact: selectedMicId } };
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            
            mediaRecorder = new MediaRecorder(stream); 
            audioChunks = []; currentAudioBlob = null;
            document.getElementById('downloadAudioBtn').disabled = true;
            document.getElementById('sysErrorArea').classList.add('hidden');
            await requestWakeLock();

            if (recognition) { try { currentSessionMap.clear(); recognition.start(); } catch(e){} }
            mediaRecorder.ondataavailable = (e) => { 
                if (e.data.size > 0) {
                    audioChunks.push(e.data); 
                    if (db) {
                        const backupBlob = new Blob(audioChunks, { type: 'audio/mp3' });
                        const tx = db.transaction('backups', 'readwrite');
                        tx.objectStore('backups').put({ id: 'latest_audio', blob: backupBlob });
                    }
                }
            };
            mediaRecorder.start(1000); isRecording = true;
            
            recBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
            recBtn.classList.add('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
            recBtn.innerHTML = '<i data-lucide="square" class="w-4 h-4 fill-current"></i> <span>録音停止</span>';
            recIndicator.classList.remove('bg-slate-600');
            recIndicator.classList.add('bg-red-500', 'animate-pulse');
            lucide.createIcons();
            
            micSelect.disabled = true; 
            document.getElementById('transcriptionPlaceholder').style.display = 'none';

            startTime = Date.now();
            timerInterval = setInterval(() => {
                const t = Math.floor((Date.now() - startTime) / 1000);
                const h = String(Math.floor(t / 3600)).padStart(2, '0'), m = String(Math.floor((t % 3600) / 60)).padStart(2, '0'), s = String(t % 60).padStart(2, '0');
                document.getElementById('timerDisplay').innerText = `${h}:${m}:${s}`;
            }, 1000);
        } catch (err) { showError(`ERR [${err.name}]: マイク起動失敗。`); }
    }
}

function updateTranscriptionUI() {
    const fullText = finalTranscript;
    document.getElementById('transcriptionDisplay').innerText = fullText;
    document.getElementById('interimDisplay').innerText = interimTranscript;
    
    if (fullText || interimTranscript) {
        document.getElementById('transcriptionPlaceholder').style.display = 'none';
        document.getElementById('downloadTransBtn').disabled = false;
    }
    
    const container = document.getElementById('terminalContainer'); 
    container.scrollTop = container.scrollHeight;
    
    localStorage.setItem('local_ai_assistant_text', finalTranscript);
}

// --- WebLLM Logic ---
async function generateSummary() {
    if (!finalTranscript) {
        alert("文字起こしデータがありません。先に録音を行ってください。");
        return;
    }

    const modelName = document.getElementById('modelNameInput').value || 'gemma-2-2b-it-q4f16_1-MLC';
    const selectedTasks = Array.from(document.querySelectorAll('input[name="aiTask"]:checked')).map(cb => cb.value);
    
    if (selectedTasks.length === 0) {
        alert("実行するAIタスクを選択してください。");
        document.getElementById('taskSelectionOverlay').classList.remove('-translate-y-full');
        return;
    }

    document.getElementById('taskSelectionOverlay').classList.add('-translate-y-full');
    document.getElementById('summaryPlaceholder').classList.add('hidden');
    document.getElementById('summaryDisplay').classList.remove('hidden');
    document.getElementById('summaryDisplay').innerHTML = "";
    document.getElementById('copyAiBtn').classList.add('hidden');
    document.getElementById('downloadTextBtn').classList.add('hidden');
    
    const loadingIndicator = document.getElementById('loadingIndicator');
    const progressContainer = document.getElementById('downloadProgressContainer');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingSubtext = document.getElementById('loadingSubtext');
    
    loadingIndicator.style.display = 'flex';
    document.getElementById('generateBtn').disabled = true;
    isProcessingAI = true;

    try {
        // Initialize or Reload Engine if model changed
        if (!engine || engine.activeModel !== modelName) {
            const isLargeModel = modelName.includes('9b');
            const sizeEstimate = isLargeModel ? "約5GB" : "約1.5GB";

            loadingTitle.innerText = "モデルを読み込み中...";
            progressContainer.classList.remove('hidden');
            progressContainer.style.display = 'flex';
            loadingSubtext.innerText = `初回はモデルのダウンロードに時間がかかります（${sizeEstimate}）。Wi-Fi環境を推奨します。`;
            
            const initProgressCallback = (initProgress) => {
                const progressPercent = Math.round(initProgress.progress * 100);
                document.getElementById('downloadProgressBar').style.width = `${progressPercent}%`;
                document.getElementById('downloadProgressText').innerText = `${progressPercent}% - ${initProgress.text}`;
            };

            // Unload previous engine if it exists to free up memory
            if (engine) {
                try {
                    await engine.unload();
                } catch (e) {
                    console.warn("Failed to unload previous engine:", e);
                }
            }

            engine = await CreateMLCEngine(
                modelName,
                { 
                    initProgressCallback: initProgressCallback,
                    chatOpts: {
                        context_window_size: 2048 // Limit context to prevent OOM
                    }
                }
            );
            engine.activeModel = modelName;
        }

        loadingIndicator.style.display = 'none';
        const summaryDisplay = document.getElementById('summaryDisplay');

        for (const task of selectedTasks) {
            let prompt = "";
            let taskTitle = "";
            let isMermaid = false;

            if (task === 'correction') {
                taskTitle = "文字起こしの補正";
                prompt = `以下の文字起こしデータは音声認識によるものです。誤字脱字を修正し、文脈に合わせて読みやすい文章に整形（補正）してください。要約はせず、できるだけ全文のニュアンスを残して出力してください。\n\n--- 文字起こしデータ ---\n${finalTranscript}`;
            } else if (task === 'minutes') {
                taskTitle = "議事録作成";
                prompt = `以下の文字起こしデータから、ビジネス議事録を作成してください。出力は日本語で行ってください。\n\n【フォーマット】\n1. 会議の目的\n2. 決定事項\n3. 議題ごとの詳細\n4. Next Action（タスクと担当）\n\n--- 文字起こしデータ ---\n${finalTranscript}`;
            } else if (task === 'mindmap') {
                taskTitle = "マインドマップ";
                isMermaid = true;
                prompt = `以下の会議内容から、主要なトピックとその関係性を示すマインドマップをMermaid形式（mindmap）で作成してください。余計な説明は省き、\`\`\`mermaid で囲まれたコードブロックのみを出力してください。日本語を使用してください。\n\n--- 会議内容 ---\n${finalTranscript}`;
            } else if (task === 'infographic') {
                taskTitle = "インフォグラフィック構成案";
                prompt = `以下の会議内容を、視覚的に分かりやすいインフォグラフィックの構成案として要約してください。セクション分け、アイコンの提案、重要な数値やキーワードを強調した形式で出力してください。出力は日本語で行ってください。\n\n--- 会議内容 ---\n${finalTranscript}`;
            }

            // Create section in UI
            const section = document.createElement('div');
            section.className = "bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden";
            section.innerHTML = `
                <div class="px-4 py-2 border-b border-slate-700 bg-slate-800 flex justify-between items-center">
                    <span class="text-xs font-bold text-emerald-400 tracking-widest uppercase">${taskTitle}</span>
                    <div class="flex gap-2 items-center">
                        <div class="task-loader w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
                        <i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-500 hidden task-done"></i>
                    </div>
                </div>
                <div class="p-4 text-slate-300 leading-relaxed whitespace-pre-wrap task-content"></div>
            `;
            summaryDisplay.appendChild(section);
            lucide.createIcons();

            const contentDiv = section.querySelector('.task-content');
            const loader = section.querySelector('.task-loader');
            const doneIcon = section.querySelector('.task-done');

            const messages = [{ role: "user", content: prompt }];
            // Add max_tokens to speed up generation and prevent OOM during long outputs
            const chunks = await engine.chat.completions.create({ 
                messages, 
                stream: true,
                temperature: 0.7,
                max_tokens: 1024
            });

            let reply = "";
            for await (const chunk of chunks) {
                const content = chunk.choices[0]?.delta?.content || "";
                reply += content;
                contentDiv.innerText = reply;
                summaryDisplay.parentElement.scrollTop = summaryDisplay.parentElement.scrollHeight;
            }

            loader.classList.add('hidden');
            doneIcon.classList.remove('hidden');

            if (isMermaid) {
                // More robust Mermaid extraction
                const mermaidMatch = reply.match(/```mermaid\n?([\s\S]*?)\n?```/i);
                const code = mermaidMatch ? mermaidMatch[1].trim() : reply.trim();
                
                contentDiv.innerHTML = `<div class="mermaid" data-code="${code.replace(/"/g, '&quot;')}">${code}</div>`;
                try {
                    await mermaid.run({ nodes: [contentDiv.querySelector('.mermaid')] });
                } catch (mErr) {
                    console.error("Mermaid Render Error:", mErr);
                    contentDiv.innerText = "図解の生成に失敗しました。コード:\n" + code;
                }
            }
        }

        document.getElementById('copyAiBtn').classList.remove('hidden');
        document.getElementById('downloadTextBtn').classList.remove('hidden');
        saveSession();

    } catch (error) {
        console.error("WebLLM Error:", error);
        
        let errorMsg = error.message || String(error);
        let isCrash = errorMsg.includes("Device was lost") || errorMsg.includes("Instance") || errorMsg.includes("disposed") || errorMsg.includes("memory");
        
        const summaryDisplay = document.getElementById('summaryDisplay');
        summaryDisplay.innerHTML = `
            <div class="bg-red-900/20 border border-red-800 p-5 rounded-lg text-red-200">
                <h3 class="font-bold text-lg mb-3 flex items-center gap-2"><i data-lucide="alert-triangle" class="w-6 h-6 text-red-500"></i> AI処理エラー</h3>
                <p class="text-sm mb-4 leading-relaxed">${isCrash ? "メモリ不足によりAIエンジンがクラッシュしました。" : errorMsg}</p>
                <div class="bg-red-950/50 p-4 rounded border border-red-900/50 text-sm text-red-300 space-y-2">
                    <p class="font-bold text-red-400">【解決方法】</p>
                    <p>1. 画面右上の「WebLLM 設定」を開く</p>
                    <p>2. モデルを「Llama 3.2 1B (超軽量)」に変更して保存</p>
                    <p>3. ページを再読み込みする</p>
                    <p class="text-xs mt-2 opacity-80">※他のタブやアプリを閉じると改善する場合があります。</p>
                </div>
            </div>
        `;
        lucide.createIcons();
        
        // Try to recover engine state
        engine = null;
    } finally {
        loadingIndicator.style.display = 'none';
        document.getElementById('generateBtn').disabled = false;
        isProcessingAI = false;
    }
}

// --- Utility ---
async function handleSave(blob, ext, desc) {
    if (!blob) return;
    const filename = `AudioLog_${new Date().getFullYear()}${String(new Date().getMonth()+1).padStart(2,'0')}${String(new Date().getDate()).padStart(2,'0')}${ext}`;
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: desc, accept: { '*/*': [ext] } }] });
            const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return;
        } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

function downloadAiOutput() {
    const content = document.getElementById('summaryDisplay').innerText;
    const blob = new Blob([content], { type: 'text/plain' });
    handleSave(blob, '.txt', 'AI分析結果');
}
