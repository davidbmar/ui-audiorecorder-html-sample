class AudioStorageManager {
  constructor() {
    this.db = null;
    this.dbName = 'AudioRecorderDB';
    this.dbVersion = 2; // Incremented to force schema update
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this.db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => {
        console.error('IndexedDB failed to open:', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        console.log('IndexedDB opened successfully');
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Sessions table - recording sessions
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionsStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionsStore.createIndex('timestamp', 'timestamp', { unique: false });
          sessionsStore.createIndex('status', 'status', { unique: false });
        }
        
        // Chunks table - individual audio segments
        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id' });
          chunksStore.createIndex('sessionId', 'sessionId', { unique: false });
          chunksStore.createIndex('chunkIndex', 'chunkIndex', { unique: false });
          chunksStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        console.log('IndexedDB schema created/updated');
      };
    });
  }

  // Session management
  async createSession(settings = {}) {
    await this.init();
    
    // Check if object store exists
    if (!this.db.objectStoreNames.contains('sessions')) {
      throw new Error('Sessions object store not found - database may need to be recreated');
    }
    
    const sessionId = `session_${new Date().toISOString().replace(/[:.]/g, '_')}`;
    const session = {
      id: sessionId,
      timestamp: Date.now(),
      totalDuration: 0,
      chunkCount: 0,
      settings: {
        chunkDuration: 5000,
        mimeType: 'audio/webm',
        ...settings
      },
      status: 'recording',
      transcription: null,
      s3Url: null,
      created: new Date().toISOString()
    };
    
    const transaction = this.db.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');
    
    return new Promise((resolve, reject) => {
      const request = store.add(session);
      request.onsuccess = () => {
        console.log('Session created:', sessionId);
        resolve(session);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async updateSession(sessionId, updates) {
    await this.init();
    
    const transaction = this.db.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');
    
    return new Promise((resolve, reject) => {
      const getRequest = store.get(sessionId);
      getRequest.onsuccess = () => {
        const session = getRequest.result;
        if (!session) {
          reject(new Error('Session not found'));
          return;
        }
        
        Object.assign(session, updates);
        const putRequest = store.put(session);
        putRequest.onsuccess = () => resolve(session);
        putRequest.onerror = () => reject(putRequest.error);
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async getSession(sessionId) {
    await this.init();
    
    const transaction = this.db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    
    return new Promise((resolve, reject) => {
      const request = store.get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllSessions() {
    await this.init();
    
    // Check if object store exists
    if (!this.db.objectStoreNames.contains('sessions')) {
      console.warn('Sessions object store not found');
      return [];
    }
    
    const transaction = this.db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const index = store.index('timestamp');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll();
      request.onsuccess = () => {
        // Sort by timestamp descending (newest first)
        const sessions = request.result.sort((a, b) => b.timestamp - a.timestamp);
        resolve(sessions);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Chunk management
  async saveChunk(sessionId, chunkIndex, blob, duration, waveformPeaks = null) {
    await this.init();
    
    const chunkId = `chunk_${sessionId}_${String(chunkIndex).padStart(3, '0')}`;
    const chunk = {
      id: chunkId,
      sessionId: sessionId,
      chunkIndex: chunkIndex,
      blob: blob,
      duration: duration,
      timestamp: Date.now(),
      waveformPeaks: waveformPeaks,
      uploaded: false,
      s3Url: null,
      size: blob.size,
      type: blob.type
    };
    
    const transaction = this.db.transaction(['chunks'], 'readwrite');
    const store = transaction.objectStore('chunks');
    
    return new Promise((resolve, reject) => {
      const request = store.add(chunk);
      request.onsuccess = () => {
        console.log('Chunk saved:', chunkId, `${blob.size} bytes`);
        resolve(chunk);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getChunksBySession(sessionId) {
    await this.init();
    
    const transaction = this.db.transaction(['chunks'], 'readonly');
    const store = transaction.objectStore('chunks');
    const index = store.index('sessionId');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll(sessionId);
      request.onsuccess = () => {
        // Sort by chunk index
        const chunks = request.result.sort((a, b) => a.chunkIndex - b.chunkIndex);
        resolve(chunks);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getChunk(chunkId) {
    await this.init();
    
    const transaction = this.db.transaction(['chunks'], 'readonly');
    const store = transaction.objectStore('chunks');
    
    return new Promise((resolve, reject) => {
      const request = store.get(chunkId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Utility methods
  async deleteSession(sessionId) {
    await this.init();
    
    const transaction = this.db.transaction(['sessions', 'chunks'], 'readwrite');
    const sessionsStore = transaction.objectStore('sessions');
    const chunksStore = transaction.objectStore('chunks');
    const chunksIndex = chunksStore.index('sessionId');
    
    return new Promise((resolve, reject) => {
      // Delete all chunks for this session
      const chunkRequest = chunksIndex.getAll(sessionId);
      chunkRequest.onsuccess = () => {
        const chunks = chunkRequest.result;
        const deletePromises = chunks.map(chunk => {
          return new Promise((res, rej) => {
            const delRequest = chunksStore.delete(chunk.id);
            delRequest.onsuccess = () => res();
            delRequest.onerror = () => rej(delRequest.error);
          });
        });
        
        Promise.all(deletePromises).then(() => {
          // Delete the session
          const sessionRequest = sessionsStore.delete(sessionId);
          sessionRequest.onsuccess = () => {
            console.log('Session and chunks deleted:', sessionId);
            resolve();
          };
          sessionRequest.onerror = () => reject(sessionRequest.error);
        }).catch(reject);
      };
      chunkRequest.onerror = () => reject(chunkRequest.error);
    });
  }

  async getStorageUsage() {
    await this.init();
    
    if (!navigator.storage || !navigator.storage.estimate) {
      return { used: 0, available: 0, percentage: 0 };
    }
    
    try {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage || 0;
      const available = estimate.quota || 0;
      const percentage = available > 0 ? Math.round((used / available) * 100) : 0;
      
      return {
        used: used,
        available: available,
        percentage: percentage,
        usedMB: Math.round(used / (1024 * 1024)),
        availableMB: Math.round(available / (1024 * 1024))
      };
    } catch (error) {
      console.warn('Could not get storage estimate:', error);
      return { used: 0, available: 0, percentage: 0 };
    }
  }

  async cleanup(maxSessions = 50) {
    await this.init();
    
    const sessions = await this.getAllSessions();
    if (sessions.length <= maxSessions) return;
    
    // Keep the most recent sessions, delete older ones
    const sessionsToDelete = sessions.slice(maxSessions);
    
    for (const session of sessionsToDelete) {
      await this.deleteSession(session.id);
    }
    
    console.log(`Cleaned up ${sessionsToDelete.length} old sessions`);
    return sessionsToDelete.length;
  }

  // Create object URLs for playback
  createObjectURL(blob) {
    return URL.createObjectURL(blob);
  }

  revokeObjectURL(url) {
    URL.revokeObjectURL(url);
  }

  // Database management
  async clearDatabase() {
    return new Promise((resolve, reject) => {
      // Close current connection
      if (this.db) {
        this.db.close();
        this.db = null;
        this.initialized = false;
      }
      
      // Delete the database
      const deleteRequest = indexedDB.deleteDatabase(this.dbName);
      deleteRequest.onsuccess = () => {
        console.log('Database cleared successfully');
        resolve();
      };
      deleteRequest.onerror = () => {
        console.error('Failed to clear database:', deleteRequest.error);
        reject(deleteRequest.error);
      };
      deleteRequest.onblocked = () => {
        console.warn('Database deletion blocked - close all tabs using this database');
      };
    });
  }
}

// Export singleton instance
window.audioStorage = new AudioStorageManager();