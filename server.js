const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

const INITIAL_CASH = 3000;

const STOCKS = [
  { id:'apple',  emoji:'🍎', name:'사과농장',  code:'APPL', price:500,  initialPrice:500,  color:'#00e896', history:[500]  },
  { id:'coffee', emoji:'☕', name:'커피왕국',  code:'CAFE', price:800,  initialPrice:800,  color:'#f5c842', history:[800]  },
  { id:'game',   emoji:'🎮', name:'게임천국',  code:'GAME', price:600,  initialPrice:600,  color:'#3b82f6', history:[600]  },
  { id:'bus',    emoji:'🚌', name:'스쿨버스',  code:'BUS',  price:400,  initialPrice:400,  color:'#a855f7', history:[400]  },
  { id:'pizza',  emoji:'🍕', name:'피자마을',  code:'PIZA', price:1000, initialPrice:1000, color:'#f97316', history:[1000] },
  { id:'book',   emoji:'📚', name:'책나라',    code:'BOOK', price:300,  initialPrice:300,  color:'#06b6d4', history:[300]  },
];
const INITIAL_PRICES = { apple:500, coffee:800, game:600, bus:400, pizza:1000, book:300 };

let gameState = { running:false, ended:false, timeLeft:5*60, speed:2, volatility:2, newsText:'시장 개장을 기다리고 있습니다...' };
const students = {};
const nameIndex = {};
let timerInterval = null, priceInterval = null;
const speedMs = [null, 3000, 2000, 1200, 700];

function stocksPayload() {
  return STOCKS.map(s => ({ id:s.id, emoji:s.emoji, name:s.name, code:s.code, color:s.color, price:s.price, history:s.history, initialPrice:s.initialPrice }));
}
function pricesPayload() {
  return STOCKS.map(s => ({ id:s.id, price:s.price, history:s.history, initialPrice:s.initialPrice }));
}

function tick() {
  const volFactor = gameState.volatility * 0.03;
  STOCKS.forEach(s => {
    const change = (Math.random() - 0.48) * volFactor;
    s.price = Math.max(50, Math.round(s.price * (1 + change)));
    s.history.push(s.price);
    if (s.history.length > 300) s.history.shift();
  });
  io.emit('prices', pricesPayload());
  broadcastLeaderboard();
}

function startPriceTick() {
  clearInterval(priceInterval);
  priceInterval = setInterval(tick, speedMs[gameState.speed]);
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    gameState.timeLeft--;
    io.emit('timer', gameState.timeLeft);
    if (gameState.timeLeft <= 0) endGame();
  }, 1000);
}

function endGame() {
  gameState.running = false;
  gameState.ended = true;
  clearInterval(timerInterval);
  clearInterval(priceInterval);
  gameState.newsText = '📣 거래 종료! 보유 주식을 현재가로 정산합니다!';
  io.emit('game_ended', { stocks: STOCKS.map(s => ({ id:s.id, emoji:s.emoji, name:s.name, price:s.price })), leaderboard: buildLeaderboard(), newsText: gameState.newsText });
}

function calcAsset(student) {
  let total = student.cash;
  for (const [sid, qty] of Object.entries(student.holdings)) {
    const stock = STOCKS.find(s => s.id === sid);
    if (stock) total += stock.price * qty;
  }
  return total;
}

function buildLeaderboard() {
  return Object.entries(students)
    .map(([id, s]) => ({ name:s.name, asset:calcAsset(s), cash:s.cash, holdings:s.holdings }))
    .sort((a,b) => b.asset - a.asset).slice(0, 15);
}

function broadcastLeaderboard() { io.emit('leaderboard', buildLeaderboard()); }

io.on('connection', (socket) => {
  socket.on('student_join', (rawName) => {
    if (!rawName) return;
    const name = rawName.trim().slice(0, 8);
    if (!name) return;
    if (nameIndex[name]) {
      const oldId = nameIndex[name];
      if (students[oldId]) { students[socket.id] = students[oldId]; delete students[oldId]; }
    } else {
      students[socket.id] = { name, cash: INITIAL_CASH, holdings: {} };
    }
    nameIndex[name] = socket.id;
    const student = students[socket.id];
    socket.emit('joined', { name: student.name, cash: student.cash, holdings: student.holdings, stocks: stocksPayload(), gameState });
    broadcastLeaderboard();
    io.to('teachers').emit('student_count', Object.keys(students).length);
  });

  socket.on('teacher_join', () => {
    socket.join('teachers');
    socket.emit('teacher_state', { gameState, stocks: stocksPayload(), studentCount: Object.keys(students).length });
  });

  socket.on('buy', ({ stockId, qty }) => {
    const student = students[socket.id];
    if (!student || !gameState.running) return;
    qty = Math.max(1, Math.min(10, parseInt(qty) || 1));
    const stock = STOCKS.find(s => s.id === stockId);
    if (!stock) return;
    const cost = stock.price * qty;
    if (student.cash < cost) { socket.emit('error_msg', `잔액이 부족해요! (필요: ${cost.toLocaleString()}원)`); return; }
    student.cash -= cost;
    student.holdings[stockId] = (student.holdings[stockId] || 0) + qty;
    socket.emit('portfolio', { cash: student.cash, holdings: student.holdings });
    broadcastLeaderboard();
  });

  socket.on('sell', ({ stockId, qty }) => {
    const student = students[socket.id];
    if (!student || !gameState.running) return;
    qty = Math.max(1, Math.min(10, parseInt(qty) || 1));
    const stock = STOCKS.find(s => s.id === stockId);
    if (!stock) return;
    const held = student.holdings[stockId] || 0;
    if (held < qty) { socket.emit('error_msg', `보유 주식이 ${held}주뿐이에요!`); return; }
    student.holdings[stockId] = held - qty;
    if (student.holdings[stockId] === 0) delete student.holdings[stockId];
    student.cash += stock.price * qty;
    socket.emit('portfolio', { cash: student.cash, holdings: student.holdings });
    broadcastLeaderboard();
  });

  socket.on('teacher_start', () => {
    if (gameState.running || gameState.ended) return;
    gameState.running = true;
    io.emit('game_started', gameState);
    startTimer(); startPriceTick();
    io.to('teachers').emit('teacher_state', { gameState });
  });

  socket.on('teacher_pause', () => {
    gameState.running = false;
    clearInterval(timerInterval); clearInterval(priceInterval);
    io.emit('game_paused');
    io.to('teachers').emit('teacher_state', { gameState });
  });

  socket.on('teacher_resume', () => {
    if (gameState.running || gameState.timeLeft <= 0) return;
    gameState.running = true;
    io.emit('game_started', gameState);
    startTimer(); startPriceTick();
  });

  socket.on('teacher_set_timer', (min) => {
    if (gameState.running) return;
    gameState.timeLeft = min * 60;
    io.emit('timer', gameState.timeLeft);
  });

  socket.on('teacher_speed', (s) => {
    gameState.speed = Math.max(1, Math.min(4, s));
    if (gameState.running) startPriceTick();
  });

  socket.on('teacher_vol', (v) => { gameState.volatility = Math.max(1, Math.min(5, v)); });

  socket.on('teacher_news', ({ text, targets, effect, random }) => {
    gameState.newsText = text;
    io.emit('news', text);
    if (random) {
      STOCKS.forEach(s => {
        s.price = Math.max(50, Math.round(s.price * (1 + (Math.random()-0.5)*0.6)));
        s.history.push(s.price); if (s.history.length > 300) s.history.shift();
      });
    } else {
      (targets||[]).forEach(tid => {
        const s = STOCKS.find(s => s.id === tid);
        if (s) { s.price = Math.max(50, Math.round(s.price*(1+effect))); s.history.push(s.price); if(s.history.length>300) s.history.shift(); }
      });
    }
    io.emit('prices', pricesPayload());
    broadcastLeaderboard();
  });

  socket.on('teacher_manual', ({ stockId, pct }) => {
    const s = STOCKS.find(s => s.id === stockId);
    if (!s) return;
    s.price = Math.max(50, Math.round(s.price*(1+pct)));
    s.history.push(s.price); if(s.history.length>300) s.history.shift();
    io.emit('prices', pricesPayload());
    broadcastLeaderboard();
  });

  socket.on('teacher_reset', () => {
    gameState.running = false; gameState.ended = false;
    gameState.timeLeft = 5*60; gameState.newsText = '시장 개장을 기다리고 있습니다...';
    clearInterval(timerInterval); clearInterval(priceInterval);
    STOCKS.forEach(s => { s.price = INITIAL_PRICES[s.id]; s.history = [s.price]; });
    Object.keys(students).forEach(id => { students[id].cash = INITIAL_CASH; students[id].holdings = {}; });
    io.emit('game_reset', { stocks: pricesPayload(), cash: INITIAL_CASH, gameState });
  });

  socket.on('disconnect', () => {
    const student = students[socket.id];
    if (student && nameIndex[student.name] === socket.id) delete nameIndex[student.name];
    delete students[socket.id];
    io.to('teachers').emit('student_count', Object.keys(students).length);
    broadcastLeaderboard();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ 불장 교실 서버 실행 중: http://localhost:${PORT}`));
