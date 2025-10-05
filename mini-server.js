// Minimal isolated express server to debug routing issues
const express = require('express');
const app = express();
const PORT = 3000;

app.get('/api/health', (req,res)=>{
  res.json({ ok:true, route:'/api/health', ts: Date.now() });
});

app.get('/api/test', (req,res)=>{
  res.json({ ok:true, route:'/api/test' });
});

app.use((req,res)=>{
  res.status(404).json({ error: 'nf', path: req.url });
});

app.listen(PORT, ()=>{
  console.log('Mini server up on port', PORT);
});
