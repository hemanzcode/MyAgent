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
    codeBackground: '#f5f5f5',
    codeBorder: '#e0e0e0',
    codeText: '#1a1a1a',
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
    codeBackground: '#1e1e1e',
    codeBorder: '#3a3a3a',
    codeText: '#d4d4d4',
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

// Component to render message content with code blocks
function MessageContent({ content, theme }) {
  const [copied, setCopied] = useState(null);

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopied(index);
    setTimeout(() => setCopied(null), 2000);
  };

  // Parse content for code blocks (```language\ncode```)
  const parseContent = (text) => {
    const parts = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.slice(lastIndex, match.index)
        });
      }

      // Add code block
      parts.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trim()
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex)
      });
    }

    return parts.length > 0 ? parts : [{ type: 'text', content: text }];
  };

  const parts = parseContent(content);

  return (
    <div>
      {parts.map((part, index) => {
        if (part.type === 'code') {
          return (
            <div
              key={index}
              style={{
                marginTop: 8,
                marginBottom: 8,
                borderRadius: 6,
                border: `1px solid ${theme.codeBorder}`,
                overflow: 'hidden'
              }}
            >
              {/* Code header */}
              <div
                style={{
                  background: theme.codeBorder,
                  padding: '6px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 12,
                  color: theme.secondaryText
                }}
              >
                <span>{part.language}</span>
                <button
                  onClick={() => copyToClipboard(part.content, index)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                    border: 'none',
                    borderRadius: 4,
                    background: theme.background,
                    color: theme.text
                  }}
                >
                  {copied === index ? '✓ Copiado' : 'Copiar'}
                </button>
              </div>
              {/* Code content */}
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  background: theme.codeBackground,
                  color: theme.codeText,
                  overflow: 'auto',
                  fontSize: 13,
                  fontFamily: 'monospace',
                  lineHeight: 1.5
                }}
              >
                <code>{part.content}</code>
              </pre>
            </div>
          );
        } else {
          // Render normal text with line breaks preserved
          return (
            <div key={index} style={{ whiteSpace: 'pre-wrap' }}>
              {part.content}
            </div>
          );
        }
      })}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenEstimate, setTokenEstimate] = useState(0);
  const [editingId, setEditingId] = useState(null); // Novo: ID da conversa sendo editada
  const [editingTitle, setEditingTitle] = useState(''); // Novo: Título temporário para edição
  const { theme, isDark, toggleTheme } = useContext(ThemeContext);

  useEffect(() => {
    const fetchConvs = async () => {
      try {
        const resp = await axios.get('http://localhost:8000/conversations');
        if (Array.isArray(resp.data) && resp.data.length > 0) {
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
        const first = { id: Date.now().toString(), title: 'Conversa 1', messages: [] };
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
    const doCreate = async () => {
      try {
        const resp = await axios.post('http://localhost:8000/conversations', { 
          title: `Conversa ${conversations.length + 1}` 
        });
        const conv = resp.data;
        const next = [{ id: conv.id, title: conv.title, messages: [] }, ...conversations];
        persist(next);
        setSelectedId(conv.id);
        return;
      } catch (e) {
        console.warn('Failed to create conversation on backend, falling back to local-only');
      }

      const id = Date.now().toString();
      const title = `Conversa ${conversations.length + 1}`;
      const next = [{ id, title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(id);
    };
    doCreate();
  };

  const selectConversation = (id) => {
    setSelectedId(id);
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

  const startEditing = (id, currentTitle) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const saveEdit = async (id) => {
    if (!editingTitle.trim()) return;
    try {
      await axios.patch(`http://localhost:8000/conversations/${id}`, { title: editingTitle });
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
    } catch (e) {
      console.error('Failed to update conversation title on backend', e);
      // Fallback local
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
    }
    setEditingId(null);
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('Tem certeza que deseja excluir esta conversa?')) return;
    try {
      await axios.delete(`http://localhost:8000/conversations/${id}`);
    } catch (e) {
      console.warn('Failed to delete conversation on backend, proceeding locally');
    }
    const next = conversations.filter((c) => c.id !== id);
    persist(next);
    if (selectedId === id) {
      setSelectedId(next.length > 0 ? next[0].id : null);
    }
  };

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  const sendMessage = async () => {
    if (!input || !selectedConv) return;
    const userMsg = { role: 'user', content: input, ts: Date.now() };

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

      const convId = resp.data && resp.data.conversation_id ? resp.data.conversation_id : selectedConv.id;
      
      // Update title if returned (new conversation)
      let withAssistant = updated.map((c) =>
        c.id === selectedConv.id || c.id === convId ? { ...c, messages: [...(c.messages || []), assistantMsg] } : c
      );

      if (resp.data.title && resp.data.title !== selectedConv.title) {
        withAssistant = withAssistant.map((c) =>
          c.id === convId ? { ...c, title: resp.data.title } : c
        );
      }

      persist(withAssistant);
      if (convId !== selectedConv.id) setSelectedId(convId);
    } catch (err) {
      console.error('Error calling backend /chat', err);
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
          <h3 style={{ margin: 0 }}>Conversas</h3>
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
              style={{
                padding: 8,
                marginBottom: 8,
                borderRadius: 6,
                cursor: 'pointer',
                background: c.id === selectedId ? theme.selected : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
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
                      padding: 4,
                      borderRadius: 4,
                      border: `1px solid ${theme.inputBorder}`,
                      background: theme.background,
                      color: theme.text
                    }}
                    autoFocus
                  />
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                    <div style={{ fontSize: 12, color: theme.secondaryText }}>
                      {(c.messages && c.messages.length) || 0} mensagens
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => startEditing(c.id, c.title)}
                  style={{
                    padding: '4px 8px',
                    border: 'none',
                    background: 'transparent',
                    color: theme.text,
                    cursor: 'pointer'
                  }}
                >
                  ✏️
                </button>
                <button
                  onClick={() => deleteConversation(c.id)}
                  style={{
                    padding: '4px 8px',
                    border: 'none',
                    background: 'transparent',
                    color: theme.text,
                    cursor: 'pointer'
                  }}
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel: chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${theme.border}` }}>
          <h2 style={{ margin: 0 }}>
            {selectedConv ? selectedConv.title : 'Selecione uma conversa'}
          </h2>
        </div>

        <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
          {selectedConv && selectedConv.messages && selectedConv.messages.length > 0 ? (
            selectedConv.messages.map((m, idx) => (
              <div key={idx} style={{ marginBottom: 16 }}>
                <div style={{ 
                  fontSize: 12, 
                  color: theme.secondaryText, 
                  marginBottom: 4,
                  fontWeight: 600
                }}>
                  {m.role === 'user' ? 'Você' : 'Assistente'}
                </div>
                <div style={{ 
                  padding: 12, 
                  background: m.role === 'user' ? theme.messageUser : theme.messageAssistant, 
                  borderRadius: 8,
                  color: theme.text
                }}>
                  <MessageContent content={m.content} theme={theme} />
                </div>
              </div>
            ))
          ) : (
            <div style={{ color: theme.secondaryText }}>
              Nenhuma mensagem ainda. Comece uma conversa.
            </div>
          )}
        </div>

        <div style={{ 
          padding: 12, 
          borderTop: `1px solid ${theme.border}`, 
          display: 'flex', 
          gap: 8, 
          alignItems: 'flex-end' 
        }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
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
                color: theme.text,
                fontFamily: 'inherit'
              }}
              disabled={loading}
              maxLength={20000}
            />
            <div style={{ fontSize: 12, color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
              Est. tokens: {tokenEstimate} {tokenEstimate > 4000 ? '(alto — pode exceder limites)' : ''}
            </div>
          </div>
          <button 
            onClick={sendMessage} 
            disabled={loading || !input} 
            style={{ 
              padding: '10px 16px', 
              minWidth: 90,
              borderRadius: 6,
              cursor: loading || !input ? 'not-allowed' : 'pointer',
              border: 'none',
              background: loading || !input ? theme.border : '#0066cc',
              color: '#ffffff',
              fontWeight: 600
            }}
          >
            {loading ? '...' : 'Enviar'}
          </button>
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