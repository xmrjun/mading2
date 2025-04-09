const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 配置参数
const config = {
  wsUrl: 'wss://ws.backpack.exchange',  // 不要在URL末尾添加斜杠
  symbol: 'BTC_USDC',                   // 交易对
  logToFile: true                       // 是否记录日志到文件
};

// 全局变量
let priceWs = null;
let bookTickerWs = null;
let tradeWs = null;
let isConnected = false;
let lastPriceData = {};
let prevPrice = null;

// 日志函数
function log(message, isError = false) {
  const timestamp = new Date().toLocaleString();
  const formattedMessage = `[${timestamp}] ${message}`;
  
  // 打印到控制台
  console.log(isError ? `\x1b[31m${formattedMessage}\x1b[0m` : formattedMessage);
  
  // 记录到文件
  if (config.logToFile) {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `price_feed_${date}.log`);
    
    fs.appendFileSync(
      logFile,
      formattedMessage + '\n',
      { encoding: 'utf8' }
    );
  }
}

// 彩色价格显示 (上涨为绿色，下跌为红色)
function colorPrice(price, prevPrice) {
  if (!prevPrice) return price;
  
  if (parseFloat(price) > parseFloat(prevPrice)) {
    return `\x1b[32m${price}↑\x1b[0m`; // 绿色上涨
  } else if (parseFloat(price) < parseFloat(prevPrice)) {
    return `\x1b[31m${price}↓\x1b[0m`; // 红色下跌
  } else {
    return `${price}=`; // 价格不变
  }
}

// 打印价格信息到控制台
function printPrice(source, price, additional = '') {
  const currentTime = new Date().toLocaleTimeString();
  const formattedPrice = colorPrice(price, prevPrice);
  
  // 更新上一次价格
  prevPrice = price;
  
  // 显示为滚动条
  console.log(`[${currentTime}] ${config.symbol} ${source}: ${formattedPrice} ${additional}`);
}

// 启动价格数据WebSocket连接
function startPriceWebSocket() {
  // 价格ticker连接
  log(`连接到价格ticker流: ${config.symbol}`);
  priceWs = new WebSocket(`${config.wsUrl}`);
  
  priceWs.on('open', () => {
    log(`价格WebSocket连接成功`);
    isConnected = true;
    
    // 订阅ticker数据
    const tickerSubscription = {
      method: "SUBSCRIBE",
      params: [`ticker.${config.symbol}`],
      id: Date.now()
    };
    
    priceWs.send(JSON.stringify(tickerSubscription));
    log(`已订阅 ticker.${config.symbol}`);

    // 发送心跳
    setInterval(() => {
      if (priceWs.readyState === WebSocket.OPEN) {
        const pingMsg = {
          method: "PING",
          id: Date.now()
        };
        priceWs.send(JSON.stringify(pingMsg));
      }
    }, 30000);

    // 3秒后尝试连接bookTicker流
    setTimeout(startBookTickerWebSocket, 3000);
    
    // 6秒后尝试连接trade流
    setTimeout(startTradeWebSocket, 6000);
  });
  
  priceWs.on('message', (data) => {
    try {
      // 打印原始数据，方便调试
      // log(`收到原始数据: ${data}`);
      
      const message = JSON.parse(data);
      
      // 处理PING响应
      if (message.id && message.result === "PONG") {
        return;
      }
      
      // 处理订阅确认
      if (message.id && message.result === null) {
        log(`订阅确认成功: ID ${message.id}`);
        return;
      }
      
      // 处理ticker数据 - 注意处理嵌套格式
      if (message.data && message.data.e === 'ticker') {
        const tickerData = message.data;
        lastPriceData.ticker = {
          price: tickerData.c,      // 当前价格
          high: tickerData.h,       // 24小时最高价
          low: tickerData.l,        // 24小时最低价
          volume: tickerData.v,     // 24小时成交量
          time: new Date(parseInt(tickerData.E / 1000)).toLocaleTimeString()
        };
        
        // 直接打印价格信息
        printPrice('行情', tickerData.c, `高:${tickerData.h} 低:${tickerData.l} 量:${tickerData.v}`);
      }
    } catch (err) {
      log(`解析消息出错: ${err.message}`, true);
      log(`原始数据: ${data}`, true);
    }
  });
  
  priceWs.on('error', (error) => {
    log(`价格WebSocket错误: ${error.message}`, true);
    isConnected = false;
  });
  
  priceWs.on('close', () => {
    log('价格WebSocket连接已关闭');
    isConnected = false;
    
    // 5秒后重连
    setTimeout(() => {
      log('正在重新连接价格WebSocket...');
      startPriceWebSocket();
    }, 5000);
  });
}

// 启动订单簿WebSocket连接
function startBookTickerWebSocket() {
  log(`连接到订单簿流: ${config.symbol}`);
  bookTickerWs = new WebSocket(`${config.wsUrl}`);
  
  bookTickerWs.on('open', () => {
    log(`订单簿WebSocket连接成功`);
    
    // 订阅bookTicker数据
    const bookTickerSubscription = {
      method: "SUBSCRIBE",
      params: [`bookTicker.${config.symbol}`],
      id: Date.now() + 1
    };
    
    bookTickerWs.send(JSON.stringify(bookTickerSubscription));
    log(`已订阅 bookTicker.${config.symbol}`);
  });
  
  bookTickerWs.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      // 处理订阅确认
      if (message.id && message.result === null) {
        log(`订单簿订阅确认成功: ID ${message.id}`);
        return;
      }
      
      // 处理bookTicker数据 - 注意处理嵌套格式
      if (message.data && message.data.e === 'bookTicker') {
        const bookData = message.data;
        lastPriceData.bookTicker = {
          bid: bookData.b,       // 最高买价
          bidQty: bookData.B,    // 最高买量
          ask: bookData.a,       // 最低卖价
          askQty: bookData.A,    // 最低卖量
          time: new Date(parseInt(bookData.E / 1000)).toLocaleTimeString()
        };
        
        // 计算价差百分比
        const spread = (parseFloat(bookData.a) - parseFloat(bookData.b)).toFixed(2);
        const spreadPercent = ((parseFloat(bookData.a) / parseFloat(bookData.b) - 1) * 100).toFixed(3);
        
        // 直接打印订单簿信息
        console.log(`[${lastPriceData.bookTicker.time}] ${config.symbol} 订单簿: 买:\x1b[32m${bookData.b}\x1b[0m(${bookData.B}) 卖:\x1b[31m${bookData.a}\x1b[0m(${bookData.A}) 差价:${spread}(${spreadPercent}%)`);
      }
    } catch (err) {
      log(`解析订单簿消息出错: ${err.message}`, true);
      log(`原始数据: ${data}`, true);
    }
  });
  
  bookTickerWs.on('error', (error) => {
    log(`订单簿WebSocket错误: ${error.message}`, true);
  });
  
  bookTickerWs.on('close', () => {
    log('订单簿WebSocket连接已关闭');
    
    // 5秒后重连
    setTimeout(() => {
      log('正在重新连接订单簿WebSocket...');
      startBookTickerWebSocket();
    }, 5000);
  });
}

// 启动交易WebSocket连接
function startTradeWebSocket() {
  log(`连接到交易流: ${config.symbol}`);
  tradeWs = new WebSocket(`${config.wsUrl}`);
  
  tradeWs.on('open', () => {
    log(`交易WebSocket连接成功`);
    
    // 订阅trade数据
    const tradeSubscription = {
      method: "SUBSCRIBE",
      params: [`trade.${config.symbol}`],
      id: Date.now() + 2
    };
    
    tradeWs.send(JSON.stringify(tradeSubscription));
    log(`已订阅 trade.${config.symbol}`);
  });
  
  tradeWs.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      // 处理订阅确认
      if (message.id && message.result === null) {
        log(`交易订阅确认成功: ID ${message.id}`);
        return;
      }
      
      // 处理trade数据 - 注意处理嵌套格式
      if (message.data && message.data.e === 'trade') {
        const tradeData = message.data;
        
        // 直接打印交易价格，使用彩色
        const side = tradeData.m ? '\x1b[32m买方挂单\x1b[0m' : '\x1b[31m卖方挂单\x1b[0m';
        printPrice('成交', tradeData.p, `${tradeData.q} ${side}`);
      }
    } catch (err) {
      log(`解析交易消息出错: ${err.message}`, true);
      log(`原始数据: ${data}`, true);
    }
  });
  
  tradeWs.on('error', (error) => {
    log(`交易WebSocket错误: ${error.message}`, true);
  });
  
  tradeWs.on('close', () => {
    log('交易WebSocket连接已关闭');
    
    // 5秒后重连
    setTimeout(() => {
      log('正在重新连接交易WebSocket...');
      startTradeWebSocket();
    }, 5000);
  });
}

// 主函数
function main() {
  console.log('\n===== Backpack BTC 价格滚动显示器 =====');
  console.log(`交易对: ${config.symbol}`);
  console.log('按 Ctrl+C 退出程序');
  console.log('------------------------');
  
  // 启动WebSocket连接
  startPriceWebSocket();
  
  // 处理退出
  process.on('SIGINT', () => {
    log('正在关闭连接并退出...');
    
    if (priceWs) priceWs.close();
    if (bookTickerWs) bookTickerWs.close();
    if (tradeWs) tradeWs.close();
    
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
}

// 启动程序
main(); 