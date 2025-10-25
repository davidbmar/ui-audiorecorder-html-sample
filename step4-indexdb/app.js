(() => {
  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }
  var logEl = $('log');
  function log(){
    var parts=[]; for (var i=0;i<arguments.length;i++){ try{parts.push(typeof arguments[i]==='string'?arguments[i]:JSON.stringify(arguments[i]));}catch(_){parts.push(String(arguments[i]));} }
    var line = new Date().toISOString() + '  ' + parts.join(' ');
    logEl.value += '\n' + line; logEl.scrollTop = logEl.scrollHeight;
    if (console && console.log) console.log('[step4-indexdb]', line);
  }
  function pad3(n){ n=String(n); while(n.length<3) n='0'+n; return n; }

  // Use CSS pixel dims for drawing (avoids double-scaling issues)
  function getCanvasSize(canvas){
    const rect = canvas.getBoundingClientRect();
    // ensure backing store matches CSS size exactly (no DPR scaling)
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)){
      canvas.width  = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
    }
    return { W: canvas.width, H: canvas.height };
  }

  // Fallback round-rect path if context.roundRect is missing
  function drawRoundRect(ctx, x, y, w, h, r){
    r = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.lineTo(x+w-r, y);
    ctx.quadraticCurveTo(x+w, y, x+w, y+r);
    ctx.lineTo(x+w, y+h-r);
    ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
    ctx.lineTo(x+r, y+h);
    ctx.quadraticCurveTo(x, y+h, x, y+h-r);
    ctx.lineTo(x, y+r);
    ctx.quadraticCurveTo(x, y, x+r, y);
    ctx.closePath();
  }

  function fmt(t){
    t = Math.max(0, t|0);
    const m = String((t/60|0)).padStart(2,'0');
    const s = String(t%60).padStart(2,'0');
    return `${m}:${s}`;
  }

  // ---------- UI refs ----------
  var timesliceInput = $('timeslice');
  var overlapInput = $('overlap');
  var startBtn = $('btn-start');
  var stopBtn  = $('btn-stop');
  var palStart = $('palette-start');
  var palStop  = $('palette-stop');
  var clearBtn = $('clearBtn');
  var list     = $('chunkList');
  var dot      = $('mic-status');
  var palette  = $('palette');
  var elapsedEl = $('elapsed');
  var card     = $('recorder-card');
  var confirmEl = $('confirm');
  var confirmDetails = $('confirm-details');
  var confirmClose = $('confirm-close');
  var storageStatus = $('storage-status');

  // ---------- state ----------
  var mediaStream = null;
  var running     = false;
  var chunkIndex  = 0;
  var chunkTimer  = null;
  var preferredMime = null;
  var startedAt = null;
  var timerId = null;
  var currentSession = null;

  // Prefer Ogg/Opus if available, then WebM/Opus.
  function chooseMime(){
    var c = ['audio/ogg;codecs=opus','audio/ogg','audio/webm;codecs=opus','audio/webm'];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported){
      for (var i=0; i<c.length; i++){ try{ if (MediaRecorder.isTypeSupported(c[i])) return c[i]; }catch(e){} }
    }
    return ''; // let browser pick
  }

  // ---------- waveform computation & drawing ----------
  var decodeCtx = null; // for decodeAudioData

  function computePeaksFromBuffer(buffer, barCount){
    // mono: use channel 0
    var data = buffer.getChannelData(0);
    var total = data.length;
    var samplesPerBar = Math.max(1, Math.floor(total / barCount));
    var peaks = new Float32Array(barCount);

    // RMS for smoother look
    for (var i=0; i<barCount; i++){
      var start = i * samplesPerBar;
      var end   = Math.min(total, start + samplesPerBar);
      var sum=0, cnt=0;
      for (var j=start; j<end; j++){ var v=data[j]; sum += v*v; cnt++; }
      var rms = Math.sqrt(sum / Math.max(1, cnt));
      peaks[i] = rms;
    }
    // Normalize 0..1
    var max = 0; for (var k=0;k<barCount;k++){ if (peaks[k] > max) max = peaks[k]; }
    var scale = max > 0 ? (1 / max) : 1;
    for (var m=0;m<barCount;m++){ peaks[m] *= scale; }
    return peaks;
  }

  // Centered, mirrored renderer that uses CSS-pixel size
  function drawBars(ctx, canvas, peaks, progressRatio){
    const size = getCanvasSize(canvas);
    const W = size.W, H = size.H;

    ctx.clearRect(0,0,W,H);

    // Layout
    const bars = peaks.length;
    const padX = 12;                     // inner horizontal padding
    const gap  = 1;                      // px between bars
    const bw   = Math.max(2, Math.floor((W - padX*2) / bars) - gap);
    const cy   = H / 2;                  // centerline
    const maxH = H - 18;                 // leave air on top/bottom
    const playedBars = Math.floor(Math.max(0, Math.min(1, progressRatio)) * bars);

    function drawCenteredBar(i, color){
      const amp = peaks[i];              // 0..1
      const h   = Math.max(2, amp * maxH);
      const y   = cy - (h / 2);
      const x   = padX + i * (bw + gap);
      ctx.fillStyle = color;
      const ry = Math.min(4, h/2);
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bw, h, ry); ctx.fill(); }
      else { drawRoundRect(ctx, x, y, bw, h, ry); ctx.fill(); }
    }

    // Draw cyan portion first (played)
    for (let i = 0; i < playedBars; i++) drawCenteredBar(i, '#35e0ff');
    // Then gray remainder
    for (let i = playedBars; i < bars; i++) drawCenteredBar(i, '#475569');

    // Subtle centerline
    ctx.fillStyle = '#ffffff10';
    ctx.fillRect(padX, Math.floor(cy) - 0.5, W - padX*2, 1);
  }

  function renderWaveform(canvas, audioEl, blob){
    // ensure backing store matches CSS size now and on resize
    getCanvasSize(canvas);

    if (!decodeCtx){
      var AC = window.AudioContext || window.webkitAudioContext;
      decodeCtx = new AC();
    }
    blob.arrayBuffer().then(function(ab){
      return decodeCtx.decodeAudioData(ab);
    }).then(function(buffer){
      // number of bars ~ (canvas.width / desired bar+gap px) in CSS pixels
      var desiredPxPerBar = 4;
      var W = canvas.getBoundingClientRect().width;
      var barCount = Math.max(60, Math.min(800, Math.floor(W / desiredPxPerBar)));
      var peaks = computePeaksFromBuffer(buffer, barCount);
      var ctx = canvas.getContext('2d');

      function repaint(){
        var ratio = (!audioEl.duration || !isFinite(audioEl.duration)) ? 0
                  : Math.max(0, Math.min(1, audioEl.currentTime / audioEl.duration));
        drawBars(ctx, canvas, peaks, ratio);
      }
      repaint();

      // keep progress (blue) synced
      audioEl.addEventListener('timeupdate', repaint);
      audioEl.addEventListener('seeked', repaint);
      audioEl.addEventListener('loadedmetadata', repaint);
      audioEl.addEventListener('play', repaint);
      audioEl.addEventListener('pause', repaint);

      // click-to-seek
      canvas.style.cursor = 'pointer';
      canvas.title = 'Click to seek';
      canvas.onclick = function(ev){
        var rect = canvas.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        var ratio = Math.min(1, Math.max(0, x / rect.width));
        if (!isNaN(audioEl.duration) && isFinite(audioEl.duration)){
          audioEl.currentTime = ratio * audioEl.duration;
          audioEl.play().catch(function(){});
        }
      };

      // re-render on resize (recompute bars for new width)
      window.addEventListener('resize', function(){
        getCanvasSize(canvas);
        var W2 = canvas.getBoundingClientRect().width;
        var barCount2 = Math.max(60, Math.min(800, Math.floor(W2 / desiredPxPerBar)));
        peaks = computePeaksFromBuffer(buffer, barCount2);
        repaint();
      });
    }).catch(function(err){
      console.warn('decode/waveform error', err);
    });
  }

  // ---------- per-chunk UI ----------
  async function renderChunk(blob, idx, duration){
    var row = document.createElement('div');
    row.className = 'chunk';

    var top = document.createElement('div'); 
    top.className = 'chunk-header';
    
    var meta = document.createElement('div'); 
    meta.className = 'meta';
    meta.textContent = 'seg-' + pad3(idx) + ' (' + (blob.type || 'audio') + ') • ' + Math.round(blob.size / 1024) + 'KB';

    var audioEl = document.createElement('audio');
    var localUrl = URL.createObjectURL(blob);
    audioEl.controls = true; 
    audioEl.preload = 'metadata'; 
    audioEl.src = localUrl;
    audioEl.className = 'chunk-audio';
    audioEl.addEventListener('loadedmetadata', function(){
      log('seg-' + pad3(idx) + ' loadedmetadata duration=' + (audioEl.duration || 0));
    });

    top.appendChild(meta); 
    top.appendChild(audioEl);

    var shell = document.createElement('div'); 
    shell.className = 'waveform-shell';
    
    var canvas = document.createElement('canvas'); 
    canvas.className = 'waveform-canvas';
    shell.appendChild(canvas);

    row.appendChild(top);
    row.appendChild(shell);
    list.appendChild(row);

    renderWaveform(canvas, audioEl, blob);

    // Save to IndexedDB if we have a current session
    if (currentSession && window.audioStorage) {
      try {
        const savedChunk = await window.audioStorage.saveChunk(
          currentSession.id, 
          idx, 
          blob, 
          duration || audioEl.duration || 0
        );
        log('Chunk saved to IndexedDB:', savedChunk.id);
        
        // Update session chunk count
        await window.audioStorage.updateSession(currentSession.id, {
          chunkCount: chunkIndex,
          totalDuration: ((Date.now() - startedAt) / 1000)
        });
        
        // Update storage status
        updateStorageStatus();
      } catch (error) {
        log('Error saving chunk to IndexedDB:', error.message);
      }
    }
  }

  // ---------- overlapping recording (eliminates gaps) ----------
  var activeRecorders = []; // Track multiple active recorders

  function recordOverlappingChunk(stream, chunkMs, overlapMs, mime, onBlob){
    var opts = mime ? { mimeType: mime } : {};
    var rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch(e){ log('MediaRecorder ctor failed:', e && e.message ? e.message : e); throw e; }

    var gotData = false;
    var startTime = Date.now();
    
    rec.ondataavailable = function(ev){
      if (ev.data && ev.data.size > 0){
        gotData = true;
        var typed = new Blob([ev.data], { type: (mime || ev.data.type || 'audio/webm') });
        var actualDuration = (Date.now() - startTime) / 1000;
        onBlob(typed, actualDuration);
      }
    };
    
    rec.onstop = function(){
      // Remove this recorder from active list
      var index = activeRecorders.indexOf(rec);
      if (index > -1) activeRecorders.splice(index, 1);
      
      if (!gotData){ 
        log('WARN: recorder stopped without data; increase chunk length?'); 
      }
    };
    
    // Add to active recorders list
    activeRecorders.push(rec);
    
    rec.start();
    
    // Stop this recorder after the full duration (chunk + overlap)
    setTimeout(function(){ 
      try { 
        rec.stop(); 
      } catch(_){ /* ignore */ } 
    }, chunkMs + overlapMs);
    
    return rec;
  }

  function stopAllRecorders(){
    log('Stopping all active recorders:', activeRecorders.length);
    activeRecorders.forEach(function(rec){
      try { 
        if (rec.state === 'recording') {
          rec.stop(); 
        }
      } catch(_){ /* ignore */ }
    });
    activeRecorders = [];
  }

  // ---------- start/stop ----------
  async function start(){
    if (running) return;
    log('Start clicked');

    var SLICE_MS = Math.max(1000, Number(timesliceInput.value) || 5000);

    try {
      // Create new session
      if (window.audioStorage) {
        currentSession = await window.audioStorage.createSession({
          chunkDuration: SLICE_MS,
          mimeType: chooseMime()
        });
        log('Created session:', currentSession.id);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      
      mediaStream = stream;
      dot.classList.remove('danger');
      dot.classList.add('good');
      running = true; 
      startBtn.disabled = true; 
      stopBtn.disabled = false;
      palStart.classList.add('hidden');
      palStop.classList.remove('hidden');

      preferredMime = chooseMime();
      log('Recording started (overlapping chunks; chunk=' + SLICE_MS + 'ms; overlap=' + OVERLAP_MS + 'ms; mime=' + (preferredMime || '(auto)') + ')');

      // Start UI timer
      startUI();

      // Overlapping recording strategy - start next recorder before previous stops
      var OVERLAP_MS = Math.max(0, Number(overlapInput.value) || 500); // Configurable overlap
      
      var loop = function(){
        if (!running) return;
        var idx = ++chunkIndex;
        
        recordOverlappingChunk(mediaStream, SLICE_MS, OVERLAP_MS, preferredMime, function(blob, actualDuration){
          log('Got overlapping chunk', idx, (blob.type||'audio/*'), (blob.size||0) + 'B', 'duration:', actualDuration.toFixed(2) + 's');
          renderChunk(blob, idx, actualDuration);
        });
        
        // Start next recorder before this one stops (creating overlap)
        if (running) { 
          chunkTimer = setTimeout(loop, SLICE_MS); // Start next chunk at normal interval
        }
      };
      
      loop();
    } catch(err) {
      log('Error starting recording:', err && (err.message || String(err)));
      dot.classList.add('danger');
    }
  }

  async function stop(){
    if (!running) return;
    running = false;
    if (chunkTimer){ clearTimeout(chunkTimer); chunkTimer = null; }
    
    // Stop all overlapping recorders
    stopAllRecorders();
    
    if (mediaStream){ mediaStream.getTracks().forEach(function(t){ t.stop(); }); mediaStream = null; }
    dot.classList.remove('good');
    startBtn.disabled = false; 
    stopBtn.disabled = true;
    palStart.classList.remove('hidden');
    palStop.classList.add('hidden');
    log('Stopped');
    
    // Finalize session
    if (currentSession && window.audioStorage) {
      try {
        const finalDuration = startedAt ? ((Date.now() - startedAt) / 1000) : 0;
        await window.audioStorage.updateSession(currentSession.id, {
          status: 'completed',
          totalDuration: finalDuration,
          chunkCount: chunkIndex
        });
        log('Session completed:', currentSession.id, `${chunkIndex} chunks, ${Math.round(finalDuration)}s`);
        updateStorageStatus();
      } catch (error) {
        log('Error updating session:', error.message);
      }
    }
    
    // Stop UI timer
    stopUI();
  }

  function clearList(){
    list.innerHTML = '';
    chunkIndex = 0;
    log('Cleared');
  }

  // ---------- session recovery ----------
  async function loadPreviousSessions() {
    if (!window.audioStorage) return;
    
    try {
      const sessions = await window.audioStorage.getAllSessions();
      log(`Found ${sessions.length} previous sessions`);
      
      if (sessions.length > 0) {
        // Load the most recent session's chunks
        const latestSession = sessions[0];
        const chunks = await window.audioStorage.getChunksBySession(latestSession.id);
        
        log(`Loading ${chunks.length} chunks from session: ${latestSession.id}`);
        
        for (const chunk of chunks) {
          const audioEl = document.createElement('audio');
          const localUrl = window.audioStorage.createObjectURL(chunk.blob);
          audioEl.controls = true;
          audioEl.preload = 'metadata';
          audioEl.src = localUrl;
          audioEl.className = 'chunk-audio';
          
          var row = document.createElement('div');
          row.className = 'chunk';

          var top = document.createElement('div'); 
          top.className = 'chunk-header';
          
          var meta = document.createElement('div'); 
          meta.className = 'meta';
          meta.textContent = 'seg-' + pad3(chunk.chunkIndex) + ' (' + (chunk.type || 'audio') + ') • ' + Math.round(chunk.size / 1024) + 'KB [saved]';

          top.appendChild(meta); 
          top.appendChild(audioEl);

          var shell = document.createElement('div'); 
          shell.className = 'waveform-shell';
          
          var canvas = document.createElement('canvas'); 
          canvas.className = 'waveform-canvas';
          shell.appendChild(canvas);

          row.appendChild(top);
          row.appendChild(shell);
          list.appendChild(row);

          renderWaveform(canvas, audioEl, chunk.blob);
        }
        
        chunkIndex = chunks.length;
        log(`Restored ${chunks.length} chunks from previous session`);
      }
      
      updateStorageStatus();
    } catch (error) {
      log('Error loading previous sessions:', error.message);
    }
  }

  // ---------- storage status ----------
  async function updateStorageStatus() {
    if (!window.audioStorage || !storageStatus) return;
    
    try {
      const usage = await window.audioStorage.getStorageUsage();
      const sessions = await window.audioStorage.getAllSessions();
      
      storageStatus.textContent = `Storage: ${usage.usedMB}MB used • ${sessions.length} sessions`;
    } catch (error) {
      storageStatus.textContent = 'Storage: Error checking';
    }
  }

  // Timer functions
  function tick(){
    if(!startedAt) return;
    const secs = (Date.now()-startedAt)/1000|0;
    elapsedEl.textContent = fmt(secs);
  }

  function startUI(){
    card.classList.add('active');
    confirmEl.classList.remove('open');
    startedAt = Date.now();
    if(timerId) clearInterval(timerId);
    timerId = setInterval(tick, 1000);
    tick();
  }

  function stopUI(){
    card.classList.remove('active');
    if(timerId) { clearInterval(timerId); timerId = null; }
    const dur = startedAt ? ((Date.now()-startedAt)/1000|0) : 0;
    startedAt = null;

    const msg = `${chunkIndex} audio chunks recorded • Duration ${fmt(dur)}`;
    confirmDetails.textContent = msg;
    confirmEl.classList.add('open');
  }

  // Palette toggle
  function togglePalette(force){
    const open = force ?? !palette.classList.contains('open');
    palette.classList.toggle('open', open);
    if(open) $('palette-input')?.focus();
  }

  // support checks
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ 
    log('ERROR: getUserMedia not supported'); 
  }
  if (!window.MediaRecorder){ 
    log('ERROR: MediaRecorder not supported'); 
  }

  // wire UI
  startBtn.addEventListener('click', start);
  stopBtn .addEventListener('click', stop);
  palStart.addEventListener('click', start);
  palStop.addEventListener('click', stop);
  clearBtn?.addEventListener('click', clearList);
  confirmClose.addEventListener('click', ()=> confirmEl.classList.remove('open'));

  // Hotkey
  window.addEventListener('keydown', (e)=>{
    const mod = e.ctrlKey || e.metaKey;
    if(mod && (e.key.toLowerCase() === 'k')){
      e.preventDefault();
      togglePalette();
    }
  });

  // Tool cards
  document.querySelectorAll('.tool-card').forEach(card => {
    card.addEventListener('click', function(){
      log('Tool clicked:', this.dataset.tool);
      // Placeholder for future functionality
    });
  });

  log('UI ready: Click Start and accept mic. Each chunk gets a centered waveform with click-to-seek.');

  // Initialize storage and load previous sessions
  if (window.audioStorage) {
    window.audioStorage.init().then(() => {
      log('IndexedDB initialized');
      loadPreviousSessions();
      storageStatus.textContent = 'Storage: Ready';
    }).catch(error => {
      log('IndexedDB initialization failed:', error.message);
      log('Attempting to clear and recreate database...');
      storageStatus.textContent = 'Storage: Resetting...';
      
      // Try to clear and reinitialize the database
      window.audioStorage.clearDatabase().then(() => {
        return window.audioStorage.init();
      }).then(() => {
        log('Database recreated successfully');
        storageStatus.textContent = 'Storage: Ready (recreated)';
      }).catch(clearError => {
        log('Failed to recreate database:', clearError.message);
        storageStatus.textContent = 'Storage: Failed';
      });
    });
  } else {
    log('Storage not available, running in memory-only mode');
    storageStatus.textContent = 'Storage: Not available';
  }
})();