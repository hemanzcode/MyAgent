import React, { useState, useEffect, createContext, useContext } from 'react';
import axios from 'axios';

const STORAGE_KEY = 'myagent_conversations_v1';
const THEME_KEY = 'myagent_theme';

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
  },
  dark: {
    background: '#1a1a1a',
    text: '#ffffff',
    secondaryText: '#999999',
    border: '#333333',
    sidebar: '#242424',
    messageUser: '#1e3a8a',
    messageAssistant: '#2d2d2d',
    selected: '#363636',
    inputBorder: '#404040',
  }
};

function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved ? JSON.parse(saved) : false;
  });

  const toggleTheme = () => {
    setIsDark(!isDark);
    localStorage.setItem(THEME_KEY, JSON.stringify(!isDark));
  };

  const theme = isDark ? themes.dark : themes.light;

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function App() {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenEstimate, setTokenEstimate] = useState(0);
  const { theme, isDark, toggleTheme } = useContext(ThemeContext);

  useEffect(() => {
    // Prefer backend conversations; fallback to localStorage if backend unavailable
    const fetchConvs = async () => {
      try {
        const resp = await axios.get('http://localhost:8000/conversations');
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          // normalize
          const mapped = resp.data.map((c) => ({ id: c.id, title: c.title, messages: [] }));
          setConversations(mapped);
          setSelectedId(mapped[0].id);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped));
          return;
        }
      } catch (e) {
        console.warn('Could not fetch conversations from backend, falling back to localStorage', e.message || e);
      }

      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setConversations(parsed);
          if (parsed.length > 0) setSelectedId(parsed[0].id);
        } catch (e) {
          console.error('Failed to parse conversations from localStorage', e);
        }
      } else {
        // create initial conversation
        const first = { id: Date.now().toString(), title: 'Conversation 1', messages: [] };
        setConversations([first]);
        setSelectedId(first.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify([first]));
      }
    };
    fetchConvs();
  }, []);

  const persist = (next) => {
    setConversations(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.error('Failed to save conversations', e);
    }
  };

  const createConversation = () => {
    // create via backend when possible
    const doCreate = async () => {
      try {
        const resp = await axios.post('http://localhost:8000/conversations', { title: `Conversation ${conversations.length + 1}` });
        const conv = resp.data;
        const next = [{ id: conv.id, title: conv.title, messages: [] }, ...conversations];
        persist(next);
        setSelectedId(conv.id);
        return;
      } catch (e) {
        console.warn('Failed to create conversation on backend, falling back to local-only');
      }

      const id = Date.now().toString();
      const title = `Conversation ${conversations.length + 1}`;
      const next = [{ id, title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(id);
    };
    doCreate();
  };

  const selectConversation = (id) => {
    setSelectedId(id);
    // fetch messages for conversation from backend if available
    const fetchMessages = async () => {
      try {
        const resp = await axios.get(`http://localhost:8000/conversations/${id}`);
        if (resp.data && resp.data.messages) {
          const next = conversations.map((c) => (c.id === id ? { ...c, messages: resp.data.messages } : c));
          persist(next);
        }
      } catch (e) {
        // ignore — keep local messages
      }
    };
    fetchMessages();
  };

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  const sendMessage = async () => {
    if (!input || !selectedConv) return;
    const userMsg = { role: 'user', content: input, ts: Date.now() };

    // Optimistic update
    const updated = conversations.map((c) =>
      c.id === selectedConv.id ? { ...c, messages: [...(c.messages || []), userMsg] } : c
    );
    persist(updated);
    setInput('');
    setLoading(true);

    try {
      const resp = await axios.post('http://localhost:8000/chat', {
        message: userMsg.content,
        conversation_id: selectedConv.id,
      });

      const assistantText = resp.data && resp.data.reply ? resp.data.reply : 'No reply';
      const assistantMsg = { role: 'assistant', content: assistantText, ts: Date.now() };

      // update using backend returned conversation id (in case one was created)
      const convId = resp.data && resp.data.conversation_id ? resp.data.conversation_id : selectedConv.id;
      const withAssistant = updated.map((c) =>
        c.id === selectedConv.id || c.id === convId ? { ...c, messages: [...(c.messages || []), assistantMsg] } : c
      );
      persist(withAssistant);
      // if convId differs (number vs string) normalize
      if (convId !== selectedConv.id) setSelectedId(convId);
    } catch (err) {
      console.error('Error calling backend /chat', err);
      // append an error message
      const errMsg = { role: 'assistant', content: 'Erro: não foi possível obter resposta do backend.', ts: Date.now() };
      const withError = updated.map((c) =>
        c.id === selectedConv.id ? { ...c, messages: [...(c.messages || []), errMsg] } : c
      );
      persist(withError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh', 
      fontFamily: 'Arial, sans-serif',
      background: theme.background,
      color: theme.text
    }}>
      {/* Left sidebar: conversations */}
      <div style={{ 
        width: 280, 
        borderRight: `1px solid ${theme.border}`, 
        padding: 12, 
        boxSizing: 'border-box',
        background: theme.sidebar
      }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: 12 
        }}>
          <h3 style={{ margin: 0 }}>Conversations</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button 
              onClick={toggleTheme}
              style={{
                padding: '6px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text
              }}
            >
              {isDark ? '☀️' : '🌙'}
            </button>
            <button 
              onClick={createConversation}
              style={{
                padding: '6px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text,
                fontSize: '16px',
                fontWeight: 'bold'
              }}
            >
              +
            </button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', height: 'calc(100% - 48px)' }}>
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => selectConversation(c.id)}
              style={{
                padding: 8,
                marginBottom: 8,
                borderRadius: 6,
                cursor: 'pointer',
                background: c.id === selectedId ? theme.selected : 'transparent',
              }}
            >
              <div style={{ fontWeight: 600 }}>{c.title}</div>
              <div style={{ fontSize: 12, color: theme.secondaryText }}>{(c.messages && c.messages.length) || 0} messages</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel: chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${theme.border}` }}>
          <h2 style={{ margin: 0 }}>{selectedConv ? selectedConv.title : 'Selecione uma conversa'}</h2>
        </div>

        <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
          {selectedConv && selectedConv.messages && selectedConv.messages.length > 0 ? (
            selectedConv.messages.map((m, idx) => (
              <div key={idx} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: theme.secondaryText, marginBottom: 4 }}>{m.role}</div>
                <div style={{ 
                  padding: 10, 
                  background: m.role === 'user' ? theme.messageUser : theme.messageAssistant, 
                  borderRadius: 6,
                  color: theme.text
                }}>
                  {m.content}
                </div>
              </div>
            ))
          ) : (
            <div style={{ color: theme.secondaryText }}>Nenhuma mensagem ainda. Comece uma conversa.</div>
          )}
        </div>

        <div style={{ padding: 12, borderTop: `1px solid ${theme.border}`, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // rough token estimate: 1 token ~= 4 chars
                setTokenEstimate(Math.ceil(e.target.value.length / 4));
              }}
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
                resize: 'vertical', 
                padding: 10, 
                borderRadius: 6, 
                border: `1px solid ${theme.inputBorder}`,
                background: theme.background,
                color: theme.text
              }}
              disabled={loading}
              maxLength={20000}
            />
            <div style={{ fontSize: 12, color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
              Est. tokens do usuário: {tokenEstimate} {tokenEstimate > 4000 ? '(alto — pode exceder limites do modelo)' : ''}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={sendMessage} disabled={loading || !input} style={{ padding: '8px 12px', minWidth: 90 }}>
              {loading ? '...' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppWithTheme() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

export default AppWithTheme;