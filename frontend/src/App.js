import React, { useState, useEffect, createContext, useContext, useRef } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import jwtDecode from 'jwt-decode';

/* ===========================
   CONSTANTES & CONFIGURAÇÃO
   =========================== */
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
const STORAGE_KEY = 'myagent_conversations_v1';
const THEME_KEY = 'myagent_theme';
const AUTH_TOKEN_KEY = 'myagent_auth_token';

const ThemeContext = createContext();

const themes = {
  light: {
    background: '#ffffff',
    text: '#000000',
    secondaryText: '#666666',
    border: '#eeeeee',
    sidebar: '#ffffff',
    messageUser: '#e6f7ff',
    messageAssistant: '#f6f6f6',
    selected: '#f0f0f0',
    inputBorder: '#dddddd',
    codeBackground: '#f5f5f5',
    codeBorder: '#e0e0e0',
    codeText: '#1a1a1a',
    spotifyGreen: '#1DB954',
    spotifyDark: '#191414',
  },
  dark: {
    background: '#0b0f0a',
    text: '#d6ffd6',
    secondaryText: '#9fb99f',
    border: '#143214',
    sidebar: '#071007',
    messageUser: '#014f01',
    messageAssistant: '#0b1a0b',
    selected: '#092209',
    inputBorder: '#143214',
    codeBackground: '#071007',
    codeBorder: '#0b2b0b',
    codeText: '#d4ffd4',
    spotifyGreen: '#1DB954',
    spotifyDark: '#191414',
  }
};

/* ===========================
   THEME PROVIDER
   =========================== */
function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch {}
  };

  const theme = isDark ? themes.dark : themes.light;

  return <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>{children}</ThemeContext.Provider>;
}

/* ===========================
   MESSAGE CONTENT
   =========================== */
function MessageContent({ content = '', theme }) {
  const [copied, setCopied] = useState(null);

  const copyToClipboard = (text, index) => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      console.warn('Clipboard failed', e);
    }
  };

  const parseContent = (text) => {
    if (!text) return [{ type: 'text', content: '' }];
    const parts = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', language: match[1] || 'text', content: match[2].trim() });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parts.push({ type: 'text', content: text.slice(lastIndex) });
    return parts.length ? parts : [{ type: 'text', content: text }];
  };

  const parts = parseContent(content);

  return (
    <div>
      {parts.map((p, i) =>
        p.type === 'code' ? (
          <div key={i} style={{ marginTop: 8, marginBottom: 8, borderRadius: 6, border: `1px solid ${theme.codeBorder}`, overflow: 'hidden' }}>
            <div style={{ background: theme.codeBorder, padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: theme.secondaryText }}>
              <span>{p.language}</span>
              <button onClick={() => copyToClipboard(p.content, i)} style={{ padding: '4px 8px', fontSize: 11, cursor: 'pointer', border: 'none', borderRadius: 4, background: theme.background, color: theme.text }}>
                {copied === i ? '✓ Copiado' : 'Copiar'}
              </button>
            </div>
            <pre style={{ margin: 0, padding: 12, background: theme.codeBackground, color: theme.codeText, overflow: 'auto', fontSize: 13, fontFamily: 'monospace', lineHeight: 1.5 }}>
              <code>{p.content}</code>
            </pre>
          </div>
        ) : (
          <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{p.content}</div>
        )
      )}
    </div>
  );
}

/* ===========================
   SPOTIFY STATUS WIDGET
   =========================== */
function SpotifyWidget({ spotifyConnected, spotifyUser, onConnect, onDisconnect, theme }) {
  return (
    <div style={{
      padding: 12,
      marginBottom: 12,
      borderRadius: 8,
      border: `1px solid ${theme.border}`,
      background: spotifyConnected ? theme.spotifyDark : theme.background,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 24 }}>🎵</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 12, color: spotifyConnected ? theme.spotifyGreen : theme.secondaryText }}>
            {spotifyConnected ? `Spotify: ${spotifyUser}` : 'Spotify desconectado'}
          </div>
          <div style={{ fontSize: 10, color: theme.secondaryText }}>
            {spotifyConnected ? 'Pronto para comandos' : 'Conecte para usar comandos de música'}
          </div>
        </div>
      </div>
      <button
        onClick={spotifyConnected ? onDisconnect : onConnect}
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          border: 'none',
          background: spotifyConnected ? '#444' : theme.spotifyGreen,
          color: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600
        }}
      >
        {spotifyConnected ? 'Desconectar' : 'Conectar'}
      </button>
    </div>
  );
}

/* ===========================
   CURRENT PLAYBACK WIDGET
   =========================== */
function CurrentPlayback({ theme }) {
  const [playback, setPlayback] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchPlayback = async () => {
    setLoading(true);
    try {
      const resp = await axios.get(`${API_BASE_URL}/spotify/current-playback`);
      setPlayback(resp.data);
    } catch (err) {
      console.error('Failed to fetch playback', err);
      setPlayback(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlayback();
    const interval = setInterval(fetchPlayback, 5000); // Atualizar a cada 5s
    return () => clearInterval(interval);
  }, []);

  if (loading && !playback) return null;
  if (!playback || !playback.playing) return null;

  const { track, device } = playback;

  return (
    <div style={{
      padding: 10,
      marginBottom: 12,
      borderRadius: 8,
      border: `1px solid ${theme.spotifyGreen}`,
      background: theme.spotifyDark,
      color: '#fff'
    }}>
      <div style={{ fontSize: 11, color: theme.spotifyGreen, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>▶️</span>
        <span>Tocando agora em {device?.name}</span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{track?.name}</div>
      <div style={{ fontSize: 11, opacity: 0.8 }}>{track?.artist} • {track?.album}</div>
      {track?.progress_ms && track?.duration_ms && (
        <div style={{ marginTop: 6, background: '#333', borderRadius: 4, height: 4, overflow: 'hidden' }}>
          <div style={{
            width: `${(track.progress_ms / track.duration_ms) * 100}%`,
            height: '100%',
            background: theme.spotifyGreen,
            transition: 'width 1s linear'
          }} />
        </div>
      )}
    </div>
  );
}

/* ===========================
   MAIN APP
   =========================== */
function App() {
  // Auth + user
  const [authToken, setAuthToken] = useState(() => {
    try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
  });
  const [user, setUser] = useState(null);

  // Spotify
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifyUser, setSpotifyUser] = useState('');

  // Conversations, UI
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');

  // Message input
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenEstimate, setTokenEstimate] = useState(0);

  // Theme
  const { theme, isDark, toggleTheme } = useContext(ThemeContext);

  // Voice / mic
  const [micAllowed, setMicAllowed] = useState(false);
  const [recording, setRecording] = useState(false);
  const wakeWord = 'amigo';
  const recognitionRef = useRef(null);

  // Notification state
  const [notification, setNotification] = useState(null);

  // ============================================================================
  // NOTIFICATION HELPER
  // ============================================================================
  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // ============================================================================
  // AXIOS INTERCEPTOR
  // ============================================================================
  useEffect(() => {
    if (authToken) {
      try {
        const decoded = jwtDecode(authToken);
        setUser(decoded);
      } catch (err) {
        console.warn('Invalid token', err);
        logout();
      }
    }
  }, [authToken]);

  useEffect(() => {
    const interceptor = axios.interceptors.request.use((config) => {
      if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
      return config;
    }, (err) => Promise.reject(err));
    return () => axios.interceptors.request.eject(interceptor);
  }, [authToken]);

  // ============================================================================
  // SPEECH RECOGNITION SETUP
  // ============================================================================
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      recognitionRef.current = null;
      return;
    }
    const r = new SpeechRecognition();
    r.continuous = false;
    r.interimResults = false;
    r.lang = 'pt-BR';
    recognitionRef.current = r;
  }, []);

  // ============================================================================
  // STORAGE HELPER
  // ============================================================================
  const persist = (next) => {
    setConversations(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  };

  // ============================================================================
  // AUTH FUNCTIONS
  // ============================================================================
  const handleLogin = async (response) => {
    try {
      const resp = await axios.post(`${API_BASE_URL}/auth/google`, { id_token: response.credential });
      const token = resp.data.access_token;
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      setAuthToken(token);
      showNotification('Login realizado com sucesso!', 'success');
    } catch (err) {
      console.error('Login failed', err);
      showNotification('Falha no login. Tente novamente.', 'error');
    }
  };

  const logout = () => {
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
    setAuthToken(null);
    setUser(null);
    setConversations([]);
    setSelectedId(null);
    setSpotifyConnected(false);
    setSpotifyUser('');
    showNotification('Logout realizado', 'info');
  };

  // ============================================================================
  // SPOTIFY FUNCTIONS
  // ============================================================================
  const checkSpotifyStatus = async () => {
    try {
      const resp = await axios.get(`${API_BASE_URL}/spotify/status`);
      if (resp.data.connected) {
        setSpotifyConnected(true);
        setSpotifyUser(resp.data.spotify_user || 'Usuário');
      } else {
        setSpotifyConnected(false);
        setSpotifyUser('');
      }
    } catch (err) {
      console.error('Failed to check Spotify status', err);
      setSpotifyConnected(false);
    }
  };

  const connectSpotify = async () => {
    try {
      const resp = await axios.get(`${API_BASE_URL}/spotify/auth-url`);
      const authUrl = resp.data.auth_url;
      // Abrir popup para autenticação
      const width = 500;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        authUrl,
        'Spotify Login',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      // Polling para verificar se popup foi fechado
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          // Verificar status após fechar popup
          setTimeout(() => {
            checkSpotifyStatus();
          }, 1000);
        }
      }, 500);
    } catch (err) {
      console.error('Failed to get Spotify auth URL', err);
      showNotification('Erro ao conectar Spotify', 'error');
    }
  };

  const disconnectSpotify = async () => {
    try {
      await axios.post(`${API_BASE_URL}/spotify/disconnect`);
      setSpotifyConnected(false);
      setSpotifyUser('');
      showNotification('Spotify desconectado', 'info');
    } catch (err) {
      console.error('Failed to disconnect Spotify', err);
      showNotification('Erro ao desconectar Spotify', 'error');
    }
  };

  // ============================================================================
  // FETCH CONVERSATIONS ON LOGIN
  // ============================================================================
  useEffect(() => {
    if (!authToken) return;

    const fetchConvs = async () => {
      try {
        const resp = await axios.get(`${API_BASE_URL}/conversations`);
        if (Array.isArray(resp.data)) {
          const mapped = resp.data.map((c) => ({ id: c.id, title: c.title, messages: [] }));
          setConversations(mapped);
          if (mapped.length > 0) setSelectedId(mapped[0].id);
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped)); } catch {}
        }
      } catch (err) {
        console.warn('Could not fetch conversations from backend', err);
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            setConversations(parsed);
            if (parsed.length > 0) setSelectedId(parsed[0].id);
          }
        } catch (e) {
          console.error('Failed to parse local storage', e);
        }
      }
    };

    fetchConvs();
    checkSpotifyStatus();
  }, [authToken]);

  // ============================================================================
  // CONVERSATION FUNCTIONS
  // ============================================================================
  const createConversation = async () => {
    try {
      const resp = await axios.post(`${API_BASE_URL}/conversations`, { title: `Conversa ${conversations.length + 1}` });
      const conv = resp.data;
      const next = [{ id: conv.id, title: conv.title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(conv.id);
      showNotification('Nova conversa criada', 'success');
    } catch (err) {
      console.warn('Failed create on backend, creating local', err);
      const id = Date.now().toString();
      const title = `Conversa ${conversations.length + 1}`;
      const next = [{ id, title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(id);
    }
  };

  const selectConversation = async (id) => {
    setSelectedId(id);
    try {
      const resp = await axios.get(`${API_BASE_URL}/conversations/${id}`);
      if (resp.data && resp.data.messages) {
        const next = conversations.map((c) => (c.id === id ? { ...c, messages: resp.data.messages.map(m => ({ ...m, ts: new Date(m.created_at).getTime() })) } : c));
        persist(next);
      }
    } catch (err) {
      console.error('Failed fetch messages', err);
    }
  };

  const saveEdit = async (id) => {
    if (!editingTitle.trim()) return;
    try {
      await axios.patch(`${API_BASE_URL}/conversations/${id}`, { title: editingTitle });
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
      showNotification('Título atualizado', 'success');
    } catch (err) {
      console.error('Failed to update title', err);
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('Tem certeza que deseja excluir esta conversa?')) return;
    try {
      await axios.delete(`${API_BASE_URL}/conversations/${id}`);
      const next = conversations.filter((c) => c.id !== id);
      persist(next);
      if (selectedId === id) setSelectedId(next.length > 0 ? next[0].id : null);
      showNotification('Conversa excluída', 'info');
    } catch (err) {
      console.error('Failed to delete conversation', err);
      const next = conversations.filter((c) => c.id !== id);
      persist(next);
      if (selectedId === id) setSelectedId(next.length > 0 ? next[0].id : null);
    }
  };

  const startEditing = (id, currentTitle) => {
    setEditingId(id);
    setEditingTitle(currentTitle || '');
  };

  // ============================================================================
  // SEND MESSAGE
  // ============================================================================
  const sendMessage = async (overrideMessage = null, overrideConversationId = null) => {
    const messageToSend = overrideMessage !== null ? overrideMessage : input;
    const convId = overrideConversationId !== null ? overrideConversationId : selectedId;

    if (!messageToSend || !convId) return;

    // Append user message locally
    const userMsg = { role: 'user', content: messageToSend, ts: Date.now() };
    const updated = conversations.map((c) => c.id === convId ? { ...c, messages: [...(c.messages || []), userMsg] } : c);
    persist(updated);
    setInput('');
    setLoading(true);

    try {
      const resp = await axios.post(`${API_BASE_URL}/chat`, {
        message: messageToSend,
        conversation_id: convId,
      });

      const assistantText = (resp.data && resp.data.reply) ? resp.data.reply : 'Sem resposta';
      const assistantMsg = { role: 'assistant', content: assistantText, ts: Date.now() };
      const returnedConvId = resp.data && resp.data.conversation_id ? resp.data.conversation_id : convId;

      let withAssistant = updated.map((c) => (c.id === convId || c.id === returnedConvId) ? { ...c, messages: [...(c.messages || []), assistantMsg] } : c);

      if (resp.data && resp.data.title) {
        withAssistant = withAssistant.map((c) => (c.id === returnedConvId ? { ...c, title: resp.data.title } : c));
      }

      persist(withAssistant);
      if (returnedConvId !== selectedId) setSelectedId(returnedConvId);

      // Se foi ação Spotify, mostrar notificação
      if (resp.data.spotify_action) {
        const action = resp.data.spotify_action;
        if (action.success) {
          showNotification('✅ ' + action.message, 'success');
        } else {
          showNotification('❌ ' + action.message, 'error');
        }
      }
    } catch (err) {
      console.error('Error in chat', err);
      const errMsg = { role: 'assistant', content: 'Erro: não foi possível obter resposta.', ts: Date.now() };
      const withError = updated.map((c) => c.id === convId ? { ...c, messages: [...(c.messages || []), errMsg] } : c);
      persist(withError);
      showNotification('Erro ao enviar mensagem', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ============================================================================
  // VOICE FUNCTIONS
  // ============================================================================
  const requestMic = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicAllowed(true);
      showNotification('Microfone autorizado', 'success');
    } catch (err) {
      console.warn('Mic permission denied', err);
      setMicAllowed(false);
      showNotification('Permissão de microfone negada', 'error');
    }
  };

  const startRecording = () => {
    const r = recognitionRef.current;
    if (!r) {
      showNotification('Reconhecimento de voz não suportado', 'error');
      return;
    }
    if (!micAllowed) {
      showNotification('Microfone não autorizado - clique em "Ativar Microfone"', 'error');
      return;
    }

    setRecording(true);

    r.onstart = () => { };
    r.onerror = (ev) => {
      console.warn('Speech recognition error', ev);
      setRecording(false);
      r.stop();
      showNotification('Erro no reconhecimento de voz', 'error');
    };
    r.onend = () => {
      setRecording(false);
    };
    r.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(r => r[0].transcript)
        .join(' ')
        .trim();

      setInput(transcript);

      if (transcript.toLowerCase().includes(wakeWord)) {
        setTimeout(() => sendMessage(transcript, selectedId), 250);
      } else {
        setTimeout(() => {
          showNotification(`Diga "${wakeWord}" para executar comando de voz`, 'info');
        }, 100);
      }
    };

    try {
      r.start();
    } catch (err) {
      console.warn('Recognition start failed', err);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    const r = recognitionRef.current;
    if (!r) return;
    try { r.stop(); } catch {}
    setRecording(false);
  };

  // ============================================================================
  // TOKEN ESTIMATE
  // ============================================================================
  useEffect(() => {
    try {
      setTokenEstimate(Math.ceil((input || '').length / 4));
    } catch { setTokenEstimate(0); }
  }, [input]);

  // ============================================================================
  // DERIVED VALUES
  // ============================================================================
  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  // ============================================================================
  // RENDER: LOGIN SCREEN
  // ============================================================================
  if (!authToken) {
    return (
      <div style={{
        display: 'flex',
        height: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
        background: 'linear-gradient(135deg, #000000 0%, #1a1a1a 100%)',
        color: '#00ff41',
        fontFamily: 'Courier New, monospace',
        flexDirection: 'column',
        gap: 20
      }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 48, textShadow: '0 0 20px #00ff41', marginBottom: 10 }}>
            MyAgent
          </h1>
          <div style={{ fontSize: 18, opacity: 0.9, marginBottom: 5 }}>
            Bem vindo, amigo! 👋
          </div>
          <p style={{ fontSize: 14, opacity: 0.7, maxWidth: 500, lineHeight: 1.6 }}>
            Controle o Spotify via comandos de voz ou texto. Integração completa com IA para uma experiência musical inteligente.
          </p>
        </div>

        <div style={{
          background: 'rgba(0, 255, 65, 0.1)',
          border: '1px solid #00ff41',
          borderRadius: 12,
          padding: 30,
          maxWidth: 400,
          width: '100%'
        }}>
          <div style={{ marginBottom: 20, textAlign: 'center' }}>
            <GoogleLogin
              onSuccess={handleLogin}
              onError={() => showNotification('Falha no login', 'error')}
              useOneTap
              theme="filled_black"
            />
          </div>

          <button
            onClick={requestMic}
            style={{
              width: '100%',
              border: '1px solid #00ff41',
              background: micAllowed ? 'rgba(0, 255, 65, 0.2)' : 'transparent',
              color: '#00ff41',
              padding: '12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8
            }}
          >
            <span style={{ fontSize: 20 }}>🎤</span>
            {micAllowed ? 'Microfone Autorizado' : 'Ativar Microfone'}
          </button>
        </div>

        <div style={{
          marginTop: 30,
          padding: 20,
          background: 'rgba(0, 255, 65, 0.05)',
          border: '1px solid rgba(0, 255, 65, 0.3)',
          borderRadius: 8,
          maxWidth: 500,
          fontSize: 12,
          lineHeight: 1.8
        }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>📋 Como usar:</div>
          <div>• Pressione e <strong>segure 🎤</strong> para falar</div>
          <div>• Use <strong>"amigo"</strong> antes do comando</div>
          <div>• Exemplos: <em>"amigo, toca linkin park"</em>, <em>"amigo, próxima música"</em></div>
          <div>• Conecte o Spotify após fazer login</div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDER: MAIN APP
  // ============================================================================
  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      fontFamily: 'Arial, sans-serif',
      background: theme.background,
      color: theme.text,
      position: 'relative'
    }}>
      {/* NOTIFICATION */}
      {notification && (
        <div style={{
          position: 'fixed',
          top: 20,
          right: 20,
          zIndex: 1000,
          padding: '12px 20px',
          borderRadius: 8,
          background: notification.type === 'error' ? '#dc3545' : notification.type === 'success' ? '#28a745' : '#17a2b8',
          color: '#fff',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          animation: 'slideIn 0.3s ease-out',
          maxWidth: 300
        }}>
          {notification.message}
        </div>
      )}

      {/* SIDEBAR */}
      <div style={{
        width: 300,
        borderRight: `1px solid ${theme.border}`,
        padding: 12,
        boxSizing: 'border-box',
        background: theme.sidebar,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto'
      }}>
        {/* HEADER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>MyAgent</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={toggleTheme}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text,
                fontSize: 16
              }}
              title={isDark ? 'Tema claro' : 'Tema escuro'}
            >
              {isDark ? '☀️' : '🌙'}
            </button>
            <button
              onClick={createConversation}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text,
                fontSize: 16,
                fontWeight: 'bold'
              }}
              title="Nova conversa"
            >
              +
            </button>
            <button
              onClick={logout}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text,
                fontSize: 12
              }}
            >
              Sair
            </button>
          </div>
        </div>

        {/* SPOTIFY WIDGET */}
        <SpotifyWidget
          spotifyConnected={spotifyConnected}
          spotifyUser={spotifyUser}
          onConnect={connectSpotify}
          onDisconnect={disconnectSpotify}
          theme={theme}
        />

        {/* CONVERSATIONS LIST */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: theme.secondaryText }}>
            CONVERSAS ({conversations.length})
          </div>
          {conversations.map((c) => (
            <div
              key={c.id}
              style={{
                padding: 10,
                marginBottom: 8,
                borderRadius: 8,
                background: c.id === selectedId ? theme.selected : 'transparent',
                border: c.id === selectedId ? `1px solid ${theme.border}` : '1px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                if (c.id !== selectedId) e.currentTarget.style.background = theme.selected;
              }}
              onMouseLeave={(e) => {
                if (c.id !== selectedId) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div onClick={() => selectConversation(c.id)} style={{ flex: 1 }}>
                {editingId === c.id ? (
                  <input
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => saveEdit(c.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(c.id); }}
                    style={{
                      width: '100%',
                      padding: 6,
                      borderRadius: 4,
                      border: `1px solid ${theme.inputBorder}`,
                      background: theme.background,
                      color: theme.text,
                      fontSize: 13
                    }}
                    autoFocus
                  />
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{c.title}</div>
                    <div style={{ fontSize: 11, color: theme.secondaryText }}>
                      {(c.messages && c.messages.length) || 0} mensagens
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); startEditing(c.id, c.title); }}
                  style={{
                    padding: '4px 8px',
                    border: 'none',
                    background: theme.background,
                    color: theme.text,
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 11
                  }}
                  title="Renomear"
                >
                  ✏️
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}
                  style={{
                    padding: '4px 8px',
                    border: 'none',
                    background: theme.background,
                    color: theme.text,
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 11
                  }}
                  title="Excluir"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* USER INFO */}
        <div style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${theme.border}`,
          fontSize: 11,
          color: theme.secondaryText
        }}>
          <div>👤 {user?.email || 'Usuário'}</div>
          <div style={{ marginTop: 4 }}>
            🎤 {micAllowed ? 'Microfone ativo' : 'Microfone inativo'}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL (CHAT) */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* HEADER */}
        <div style={{
          padding: 16,
          borderBottom: `1px solid ${theme.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>
            {selectedConv ? selectedConv.title : 'Selecione uma conversa'}
          </h2>
          {selectedConv && (
            <div style={{ fontSize: 12, color: theme.secondaryText }}>
              {selectedConv.messages?.length || 0} mensagens
            </div>
          )}
        </div>

        {/* CURRENT PLAYBACK */}
        {spotifyConnected && <CurrentPlayback theme={theme} />}

        {/* MESSAGES AREA */}
        <div style={{
          flex: 1,
          padding: 16,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}>
          {selectedConv && selectedConv.messages && selectedConv.messages.length > 0 ? (
            selectedConv.messages.map((m, idx) => (
              <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{
                  fontSize: 12,
                  color: theme.secondaryText,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}>
                  <span>{m.role === 'user' ? '👤' : '🤖'}</span>
                  <span>{m.role === 'user' ? 'Você' : 'MyAgent'}</span>
                </div>
                <div style={{
                  padding: 14,
                  background: m.role === 'user' ? theme.messageUser : theme.messageAssistant,
                  borderRadius: 12,
                  color: theme.text,
                  maxWidth: '85%',
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}>
                  <MessageContent content={m.content} theme={theme} />
                </div>
              </div>
            ))
          ) : (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              color: theme.secondaryText,
              textAlign: 'center',
              gap: 16
            }}>
              <div style={{ fontSize: 48 }}>💬</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Nenhuma mensagem ainda</div>
              <div style={{ fontSize: 13, maxWidth: 400, lineHeight: 1.6 }}>
                Comece uma conversa digitando ou usando comandos de voz.
                {!spotifyConnected && ' Conecte o Spotify para usar comandos musicais!'}
              </div>
              {!spotifyConnected && (
                <button
                  onClick={connectSpotify}
                  style={{
                    padding: '10px 20px',
                    borderRadius: 8,
                    border: 'none',
                    background: theme.spotifyGreen,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600
                  }}
                >
                  🎵 Conectar Spotify
                </button>
              )}
            </div>
          )}
          {loading && (
            <div style={{
              padding: 14,
              background: theme.messageAssistant,
              borderRadius: 12,
              maxWidth: '85%',
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}>
              <div style={{ fontSize: 12, color: theme.secondaryText }}>MyAgent está digitando</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <span style={{ animation: 'blink 1.4s infinite', animationDelay: '0s' }}>●</span>
                <span style={{ animation: 'blink 1.4s infinite', animationDelay: '0.2s' }}>●</span>
                <span style={{ animation: 'blink 1.4s infinite', animationDelay: '0.4s' }}>●</span>
              </div>
            </div>
          )}
        </div>

        {/* INPUT AREA */}
        <div style={{
          padding: 12,
          borderTop: `1px solid ${theme.border}`,
          background: theme.sidebar
        }}>
          {/* Token estimate & controls */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
            fontSize: 11,
            color: theme.secondaryText
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
                📊 Tokens: {tokenEstimate} {tokenEstimate > 4000 ? '(muito alto!)' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={requestMic}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  border: `1px solid ${theme.border}`,
                  background: micAllowed ? theme.spotifyGreen : theme.background,
                  color: micAllowed ? '#fff' : theme.text,
                  fontSize: 11,
                  fontWeight: 600
                }}
              >
                🎧 {micAllowed ? 'Mic ON' : 'Ativar Mic'}
              </button>
            </div>
          </div>

          {/* Input row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={loading ? 'Enviando...' : 'Digite sua mensagem... (Shift+Enter para nova linha)'}
                style={{
                  width: '100%',
                  minHeight: 60,
                  maxHeight: 200,
                  resize: 'vertical',
                  padding: 12,
                  borderRadius: 8,
                  border: `1px solid ${theme.inputBorder}`,
                  background: theme.background,
                  color: theme.text,
                  fontFamily: 'inherit',
                  fontSize: 14
                }}
                disabled={loading || !selectedId}
                maxLength={20000}
              />
            </div>

            {/* Push-to-talk button */}
            <button
              onMouseDown={(e) => { e.preventDefault(); startRecording(); }}
              onMouseUp={(e) => { e.preventDefault(); stopRecording(); }}
              onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
              onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
              style={{
                padding: 12,
                borderRadius: '50%',
                width: 52,
                height: 52,
                border: `2px solid ${recording ? '#dc3545' : theme.border}`,
                background: recording ? '#dc3545' : theme.background,
                color: recording ? '#fff' : theme.text,
                cursor: 'pointer',
                fontSize: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
                boxShadow: recording ? '0 0 20px rgba(220, 53, 69, 0.5)' : 'none'
              }}
              title="Pressione e segure para falar"
            >
              🎤
            </button>

            {/* Send button */}
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input || !selectedId}
              style={{
                padding: '12px 20px',
                minWidth: 100,
                height: 52,
                borderRadius: 8,
                cursor: loading || !input || !selectedId ? 'not-allowed' : 'pointer',
                border: 'none',
                background: loading || !input || !selectedId ? theme.border : '#0066cc',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: 14,
                transition: 'all 0.2s'
              }}
            >
              {loading ? '⏳' : '📤 Enviar'}
            </button>
          </div>

          {/* Help text */}
          <div style={{
            marginTop: 8,
            fontSize: 11,
            color: theme.secondaryText,
            textAlign: 'center'
          }}>
            💡 Dica: Use <strong>"amigo"</strong> antes de comandos de voz. Ex: "amigo, toca linkin park"
          </div>
        </div>
      </div>

      {/* CSS ANIMATIONS */}
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        @keyframes blink {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/* ===========================
   APP WRAPPER
   =========================== */
function AppWithTheme() {
  return (
    <GoogleOAuthProvider clientId={process.env.REACT_APP_GOOGLE_CLIENT_ID}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </GoogleOAuthProvider>
  );
}

export default AppWithTheme;