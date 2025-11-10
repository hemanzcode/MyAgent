import React, { useState, useEffect } from 'react';
import axios from 'axios';

function App() {
  const [message] = useState('Hello World');
  const [status, setStatus] = useState('');
  const [messages, setMessages] = useState([]);

  const fetchMessages = async () => {
    try {
      const response = await axios.get('http://localhost:8000/messages');
      setMessages(response.data);
    } catch (error) {
      console.error('Error fetching messages:', error);
    }
  };

  useEffect(() => {
    fetchMessages();
  }, []);

  const sendMessage = async () => {
    try {
      setStatus('Sending...');
      await axios.post('http://localhost:8000/message', { message });
      setStatus('Message sent successfully!');
      fetchMessages(); // Atualiza a lista após enviar
    } catch (error) {
      console.error('Error sending message:', error);
      setStatus('Error sending message: ' + error.message);
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h1>{message}</h1>
      <button onClick={sendMessage}>Send to Backend</button>
      {status && <p>{status}</p>}
      
      <div style={{ marginTop: '30px' }}>
        <h2>Saved Messages:</h2>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {messages.map(msg => (
            <li key={msg.id} style={{ margin: '10px 0', padding: '10px', border: '1px solid #ddd', borderRadius: '5px' }}>
              {msg.content}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default App;