import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import Tesseract from 'tesseract.js';
import * as db from '../db/database.js';

// ===== TOAST CONTEXT =====
const ToastContext = createContext();

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warning' ? '⚠' : 'ℹ'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ===== GROUPS HOOK =====
export function useGroups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadGroups = useCallback(async () => {
    try {
      const data = await db.getAllGroups();
      data.sort((a, b) => b.updatedAt - a.updatedAt);
      setGroups(data);
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  const createGroup = async (name, members) => {
    const group = await db.createGroup(name, members);
    await loadGroups();
    return group;
  };

  const updateGroup = async (group) => {
    await db.saveGroup(group);
    await loadGroups();
  };

  const deleteGroup = async (id) => {
    await db.deleteGroup(id);
    await loadGroups();
  };

  return { groups, loading, createGroup, updateGroup, deleteGroup, refresh: loadGroups };
}

// ===== EXPENSES HOOK =====
export function useExpenses(groupId) {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadExpenses = useCallback(async () => {
    if (!groupId) return;
    try {
      const data = await db.getExpensesByGroup(groupId);
      data.sort((a, b) => b.createdAt - a.createdAt);
      setExpenses(data);
    } catch (err) {
      console.error('Failed to load expenses:', err);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const addExpense = async (expenseData) => {
    const expense = await db.createExpense({ ...expenseData, groupId });
    await loadExpenses();
    return expense;
  };

  const updateExpense = async (expense) => {
    await db.saveExpense(expense);
    await loadExpenses();
  };

  const removeExpense = async (id) => {
    await db.deleteExpense(id);
    await loadExpenses();
  };

  return { expenses, loading, addExpense, updateExpense, removeExpense, refresh: loadExpenses };
}

// ===== OCR HOOK =====
let cachedWorker = null;

export function useOCR() {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const recognize = useCallback(async (imageSource) => {
    setIsProcessing(true);
    setProgress(5);
    setStatus('Initializing OCR engine...');

    try {
      const langPath = typeof window !== 'undefined' ? window.location.origin : '.';

      if (!cachedWorker) {
        setStatus('Loading OCR language model...');
        setProgress(15);

        cachedWorker = await Tesseract.createWorker('eng', 1, {
          langPath,
          cacheMethod: 'readOnly',
          logger: (m) => {
            if (m.status === 'recognizing text') {
              setProgress(30 + Math.round(m.progress * 60));
              setStatus('Recognizing text (' + Math.round(m.progress * 100) + '%)...');
            } else if (m.status === 'loading language traineddata') {
              setProgress(15 + Math.round(m.progress * 15));
              setStatus('Loading language model...');
            }
          },
        });

        await cachedWorker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: '6',
        });
      }

      setStatus('Processing receipt text & layout...');
      setProgress(30);

      const result = await cachedWorker.recognize(imageSource, {}, { blocks: true });
      setProgress(95);
      setStatus('Structuring line items...');

      setProgress(100);
      setStatus('Done!');
      setIsProcessing(false);

      return result.data;
    } catch (err) {
      console.error('OCR error:', err);
      if (cachedWorker) {
        try { await cachedWorker.terminate(); } catch { /* ignore */ }
        cachedWorker = null;
      }
      setStatus('Error: ' + err.message);
      setIsProcessing(false);
      throw err;
    }
  }, []);

  const cancel = useCallback(async () => {
    if (cachedWorker) {
      try {
        await cachedWorker.terminate();
      } catch {
        // ignore cleanup errors
      }
      cachedWorker = null;
    }
    setIsProcessing(false);
    setStatus('Cancelled');
  }, []);

  return { recognize, cancel, progress, status, isProcessing };
}

// ===== CAMERA HOOK =====
export function useCamera() {
  const [stream, setStream] = useState(null);
  const [error, setError] = useState(null);
  const [hasPermission, setHasPermission] = useState(null);
  const videoRef = useRef(null);

  const startCamera = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      setStream(mediaStream);
      setHasPermission(true);
      setError(null);
      return mediaStream;
    } catch (err) {
      setHasPermission(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('Camera permission denied. Please use file upload instead.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found. Please use file upload instead.');
      } else {
        setError('Could not access camera: ' + err.message);
      }
      return null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      setStream(null);
    }
  }, [stream]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current) return null;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.9);
  }, []);

  useEffect(() => {
    return () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, [stream]);

  return { startCamera, stopCamera, capturePhoto, stream, error, hasPermission, videoRef };
}
