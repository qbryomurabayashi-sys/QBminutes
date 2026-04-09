import { CreateMLCEngine } from "@mlc-ai/web-llm";

// Lucide Icons Initialization
lucide.createIcons();

// --- State Variables ---
let isRecording = false;
let timerInterval, startTime;
let mediaRecorder = null, audioChunks = [], currentAudioBlob = null;
let finalTranscript = '', interimTranscript = '', recognition = null, wakeLock = null;
let currentSessionMap = new Map(); 
let db = null; 

// WebLLM Engine
let engine = null;

// --- IndexedDB Initialization (Audio Backup) ---
const dbReq = indexedDB.open("LocalAIAssistantDB", 1);
dbReq.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('backups')) {
        db.createObjectStore('backups', { keyPath: 'id' });
    }
};
dbReq.onsuccess = (e) => {
    db = e.target.result;
    checkRecovery();
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
window.addEventListener('DOMContentLoaded', () => {
    initApp();

    // Buttons
    document.getElementById('recBtn').addEventListener('click', toggleRecording);
    document.getElementById('refreshMicBtn').addEventListener('click', updateMicList);
    document.getElementById('downloadAudioBtn').addEventListener('click', () => handleSave(currentAudioBlob, '.mp3', 'MP3音声データ'));
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

    // Load Settings
    const savedModel = localStorage.getItem('webllm_model');
    if (savedModel) document.getElementById('modelNameInput').value = savedModel;

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
            
            document.getElementById('summaryDisplay').style.display = 'none';
            document.getElementById('summaryPlaceholder').style.display = 'flex';
            document.getElementById('copyAiBtn').classList.add('hidden');
            document.getElementById('timerDisplay').innerText = '00:00:00';
        }
    });

    // Prevent accidental close
    window.addEventListener('beforeunload', (e) => {
        if (isRecording) {
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
                    currentSessionMap.set(i, { time: currentTime, text: res[0].transcript });
                } else {
                    interim += res[0].transcript;
                }
            }
            interimTranscript = interim;
            updateTranscriptionUI();
        };

        recognition.onend = () => { 
            if (isRecording) { 
                for (let [index, item] of currentSessionMap.entries()) {
                    finalTranscript += `[${item.time}] ${item.text}\n`;
                }
                currentSessionMap.clear();
                
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
            for (let [index, item] of currentSessionMap.entries()) {
                finalTranscript += `[${item.time}] ${item.text}\n`;
            }
            currentSessionMap.clear();

            if (interimTranscript) {
                finalTranscript += `[${document.getElementById('timerDisplay').innerText}] ${interimTranscript}\n`;
                interimTranscript = ''; 
            }
            updateTranscriptionUI();
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
    let sessionText = '';
    for (let [index, item] of currentSessionMap.entries()) {
        sessionText += `[${item.time}] ${item.text}\n`;
    }
    const fullText = finalTranscript + sessionText;
    document.getElementById('transcriptionDisplay').innerText = fullText;
    document.getElementById('interimDisplay').innerText = interimTranscript;
    
    if (fullText || interimTranscript) {
        document.getElementById('transcriptionPlaceholder').style.display = 'none';
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

    const modelName = document.getElementById('modelNameInput').value || 'gemma-2b-it-q4f32_1-MLC';
    const summaryType = document.getElementById('summaryType').value;

    let prompt = "";
    if (summaryType === 'correction') {
        prompt = `以下の文字起こしデータは音声認識によるものです。誤字脱字を修正し、文脈に合わせて読みやすい文章に整形（補正）してください。要約はせず、できるだけ全文のニュアンスを残して出力してください。\n\n--- 文字起こしデータ ---\n${finalTranscript}`;
    } else if (summaryType === 'minutes') {
        prompt = `以下の文字起こしデータから、ビジネス議事録を作成してください。出力は日本語で行ってください。\n\n【フォーマット】\n1. 会議の目的\n2. 決定事項\n3. 議題ごとの詳細\n4. Next Action（タスクと担当）\n\n--- 文字起こしデータ ---\n${finalTranscript}`;
    } else if (summaryType === 'interview') {
        prompt = `以下の面談の文字起こしデータから、面談要約を作成してください。出力は日本語で行ってください。\n\n【フォーマット】\n1. 面談の目的と主要な話題\n2. 懸念事項・課題\n3. 次のアクション\n4. 特記事項\n\n--- 文字起こしデータ ---\n${finalTranscript}`;
    }

    document.getElementById('summaryPlaceholder').style.display = 'none';
    document.getElementById('summaryDisplay').style.display = 'none';
    document.getElementById('copyAiBtn').classList.add('hidden');
    
    const loadingIndicator = document.getElementById('loadingIndicator');
    const progressContainer = document.getElementById('downloadProgressContainer');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingSubtext = document.getElementById('loadingSubtext');
    
    loadingIndicator.style.display = 'flex';
    document.getElementById('generateBtn').disabled = true;

    try {
        // Initialize or Reload Engine if model changed
        if (!engine || engine.activeModel !== modelName) {
            loadingTitle.innerText = "モデルを読み込み中...";
            progressContainer.classList.remove('hidden');
            loadingSubtext.innerText = "初回はモデルのダウンロードに時間がかかります（数GB）。Wi-Fi環境を推奨します。";
            
            const initProgressCallback = (initProgress) => {
                const progressPercent = Math.round(initProgress.progress * 100);
                document.getElementById('downloadProgressBar').style.width = `${progressPercent}%`;
                document.getElementById('downloadProgressText').innerText = `${progressPercent}% - ${initProgress.text}`;
            };

            engine = await CreateMLCEngine(
                modelName,
                { initProgressCallback: initProgressCallback }
            );
            engine.activeModel = modelName;
        }

        loadingTitle.innerText = "AI 推論中...";
        progressContainer.classList.add('hidden');
        loadingSubtext.innerText = "ブラウザのWebGPUを使用して推論を行っています...";

        const messages = [
            { role: "user", content: prompt }
        ];

        // Stream the response
        const chunks = await engine.chat.completions.create({
            messages,
            stream: true,
        });

        document.getElementById('summaryDisplay').innerText = "";
        document.getElementById('summaryDisplay').style.display = 'block';
        loadingIndicator.style.display = 'none';

        let reply = "";
        for await (const chunk of chunks) {
            const content = chunk.choices[0]?.delta?.content || "";
            reply += content;
            document.getElementById('summaryDisplay').innerText = reply;
            
            // Auto scroll
            const container = document.getElementById('summaryDisplay').parentElement;
            container.scrollTop = container.scrollHeight;
        }

        document.getElementById('copyAiBtn').classList.remove('hidden');
    } catch (error) {
        console.error("WebLLM Error:", error);
        document.getElementById('summaryDisplay').innerText = `【エラーが発生しました】\n\n詳細: ${error.message}\n\n■ 確認事項:\n1. お使いのブラウザがWebGPUをサポートしているか確認してください（Chrome推奨）。\n2. デバイスのメモリ（RAM/VRAM）が不足している可能性があります。`;
        document.getElementById('summaryDisplay').style.display = 'block';
        loadingIndicator.style.display = 'none';
    } finally {
        document.getElementById('generateBtn').disabled = false;
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
