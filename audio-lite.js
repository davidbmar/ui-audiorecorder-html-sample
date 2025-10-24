// audio-lite.js (ES5-safe, no top-level await)
try { if (MediaRecorder.isTypeSupported(mt)) return mt; } catch(e){}
}
}
return '';
}


function pad3(n){ n = String(n); while(n.length<3) n='0'+n; return n; }
function ymd(){ var d=new Date(); var m=('0'+(d.getMonth()+1)).slice(-2); var day=('0'+d.getDate()).slice(-2); return d.getFullYear()+'-'+m+'-'+day; }


function buildKey(idx){
var prefix = (sessionPrefixInput.value || 'users/anon/audio/sessions').replace(/\/+$/,'');
var ext = (currentMime && currentMime.indexOf('ogg')>-1) ? 'ogg' : 'webm';
return prefix + '/' + ymd() + '-' + sessionId + '/seg-' + pad3(idx) + '.' + ext;
}


function getPresignedUrl(key, contentType){
var endpoint = presignInput.value;
if (!endpoint) return Promise.reject(new Error('Presign endpoint is empty'));
return fetch(endpoint, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ key: key, contentType: contentType })
}).then(function(res){
if (!res.ok){
return res.text().then(function(t){ throw new Error('Presign failed: '+res.status+' '+t); });
}
return res.json();
}).then(function(data){
if (!data.url) throw new Error('Presign response missing url');
return { url: data.url, publicUrl: data.publicUrl || null };
});
}


function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }


function putWithRetry(url, blob, headers, attempts){
attempts = attempts || 3;
var i = 0;
function tryOnce(){
i++;
return fetch(url, { method:'PUT', body: blob, headers: headers })
.then(function(r){ if (!r.ok) return r.text().then(function(t){ throw new Error('PUT '+r.status+' '+t); }); })
.catch(function(e){
log('Upload retry '+i+'/'+attempts+' failed:', e.message);
if (i < attempts) return sleep(500*i).then(tryOnce);
throw e;
});
}
return tryOnce();
}


function renderChunkRow(entry){
var row = document.createElement('div');
row.className = 'chunk';


var meta = document.createElement('div');
meta.className = 'meta';
meta.innerHTML = '<div><strong>seg-'+pad3(entry.idx)+'</strong> <span>('+(entry.contentType || entry.blob.type || 'audio')+')</span></div>'+
'<div>key: <code>'+entry.key+'</code></div>'+
(entry.remoteUrl ? '<div>remote: <a href="'+entry.remoteUrl+'" target="_blank">open</a></div>' : '');


var actions = document.createElement('div');
actions.className = 'actions';


var playLocal = document.createElement('button');
playLocal.textContent = 'Play Local';
playLocal.onclick = function(){ player.src = entry.localUrl; player.play().catch(function(){}); };


var playRemote = document.createElement('button');
playRemote.textContent = 'Play Remote';
playRemote.disabled = !entry.remoteUrl;
playRemote.onclick = function(){ if(entry.remoteUrl){ player.src = entry.remoteUrl; player.play().catch(function(){}); } };


actions.appendChild(playLocal);
actions.appendChild(playRemote);


row.appendChild(meta);
row.appendChild(actions);
list.appendChild(row);
})();
