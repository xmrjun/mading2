const WebSocket = require('ws');
const { defaultLogger } = require('../utils/logger');
const crypto = require('crypto');

/**
 * WebSocket管理器类 - 负责处理与交易所的WebSocket连接
 */
class WebSocketManager {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 配置对象
   * @param {Object} options.logger - 日志记录器
   * @param {Function} options.onMessage - 消息处理回调
   * @param {Function} options.onPrice - 价格更新回调
   */
  constructor(options = {}) {
    // 优先使用配置中的WebSocket URL，然后是选项中的URL，最后使用默认值
    this.wsUrl = options.config?.websocket?.url || options.wsUrl || 'wss://ws.backpack.exchange';
    this.config = options.config || {};
    this.ws = null;
    this.connectionActive = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.logger = options.logger || console;
    this.onMessage = options.onMessage || (() => {});
    
    // 修复onPriceUpdate回调 - 确保正确设置
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    
    // 🔑 订单状态更新回调
    this.onOrderUpdate = options.onOrderUpdate || (() => {});
    
    // 🔑 余额更新回调
    this.onBalanceUpdate = options.onBalanceUpdate || (() => {});
    
    // 🔑 认证信息（用于私有WebSocket订阅）
    this.privateKey = options.config?.api?.privateKey;
    this.publicKey = options.config?.api?.publicKey;
    
    // 验证和记录回调函数设置情况
    if (typeof this.onPriceUpdate === 'function') {
      this.logger.log('WebSocketManager: onPriceUpdate回调已设置');
    } else {
      this.logger.log('警告: WebSocketManager.onPriceUpdate未正确设置');
    }
    
    // 价格更新控制
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
    this.logThrottleMs = 5000; // 每5秒最多记录一次价格
    this.logPriceChange = 0.05; // 记录百分比变化超过5%的价格
    
    // 记录控制
    this.shouldLog = true;
    this.logHeartbeats = false;
    
    // 日志采样率控制
    this.messageSampleRate = 0.01; // 1%的消息会被记录
    this.priceSampleRate = 0.005; // 0.5%的价格更新会被记录到文件
    this.debugMode = false; // 默认关闭调试模式
  }
  
  /**
   * 重置日志控制参数
   */
  resetLogControl() {
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
  }
  
  /**
   * 设置价格WebSocket连接
   * @param {string} symbol - 交易对符号
   */
  setupPriceWebSocket(symbol) {
    // 关闭现有连接
    if (this.ws) {
      this.closeWebSocket();
    }

    this.logger.log(`开始建立WebSocket连接: ${this.wsUrl}`);
    
    try {
      // 创建WebSocket连接
      this.ws = new WebSocket(this.wsUrl);
      
      // 连接打开时的处理
      this.ws.on('open', () => {
        this.connectionActive = true;
        this.logger.log('WebSocket连接已建立');
        
        // 订阅行情频道
        this.subscribeTicker(symbol);
        
        // 🔑 订阅私有订单更新（如果有API密钥）
        if (this.privateKey && this.publicKey) {
          setTimeout(() => {
            this.subscribeOrderUpdates();
          }, 1000); // 延迟1秒确保连接稳定
        }
        
        // 设置心跳
        this.setupHeartbeat();
      });
      
      // 接收消息时的处理
      this.ws.on('message', (data) => {
        try {
          const now = new Date();
          let message = {};
          
          try {
            message = JSON.parse(data.toString());
            // 记录接收到的消息类型到日志文件，大幅降低采样率
            if (Math.random() < this.messageSampleRate && this.debugMode) {
              this.logger.logToFile(`收到WS消息类型: ${JSON.stringify(Object.keys(message))}`);
              this.logger.logToFile(`消息内容: ${data.toString().substring(0, 150)}...`);
            }
          } catch (parseError) {
            this.logger.log(`解析WebSocket消息失败: ${parseError.message}`);
            return;
          }
          
          // 调用消息回调
          if (typeof this.onMessage === 'function') {
            this.onMessage(message);
          }
          
          // 处理PONG响应 - 不记录日志
          if (message.result === 'PONG') {
            return;
          }
          
          // 处理订阅成功响应
          if (message.result === null && message.id) {
            this.logger.log(`订阅确认: ID=${message.id}`);
            return;
          }
          
          // 🔑 处理订单状态更新
          if (message.channel === 'orderUpdate' || 
              message.stream === 'orderUpdate' || 
              message.e === 'executionReport' ||
              (message.data && message.data.e === 'executionReport')) {
            this.processOrderUpdate(message);
          }
          // 🔑 处理余额更新
          else if (message.channel === 'account' || 
                   message.stream === 'account' ||
                   message.e === 'outboundAccountPosition' ||
                   (message.data && message.data.e === 'outboundAccountPosition')) {
            this.processBalanceUpdate(message);
          }
          // 处理价格数据 - 尝试多种可能的格式
          else if (
            (message.channel === 'ticker' && message.data) ||
            (message.e === 'ticker') ||
            (message.type === 'ticker') ||
            (message.stream && message.stream.includes('ticker') && message.data) ||
            (message.s && message.c) ||  // Binance格式
            (message.symbol && message.price) ||  // 通用格式
            (message.data && message.data.s && message.data.c)  // 嵌套格式
          ) {
            // 不记录每个价格消息，直接处理
            this.processPriceData(message, symbol, now);
          } else {
            // 记录未识别的消息类型，极低频率
            if (Math.random() < 0.01 && this.debugMode) {
              this.logger.logToFile(`未识别的消息格式: ${JSON.stringify(message).substring(0, 100)}...`);
            }
          }
        } catch (error) {
          this.logger.log(`处理WebSocket消息错误: ${error.message}`);
        }
      });
      
      // 连接关闭时的处理
      this.ws.on('close', () => {
        this.connectionActive = false;
        this.logger.log('WebSocket连接已关闭');
        
        // 清理心跳
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        
        // 尝试重连
        if (!this.reconnectTimeout) {
          this.reconnectTimeout = setTimeout(() => {
            this.logger.log('尝试重新连接WebSocket...');
            this.reconnectTimeout = null;
            this.setupPriceWebSocket(symbol);
          }, 5000);
        }
      });
      
      // 错误处理
      this.ws.on('error', (error) => {
        this.logger.log(`WebSocket错误: ${error.message}`);
      });
    } catch (error) {
      this.logger.log(`建立WebSocket连接失败: ${error.message}`);
    }
  }
  
  /**
   * 🔑 处理订单状态更新
   * @param {Object} message - 订单更新消息
   */
  processOrderUpdate(message) {
    try {
      let orderData = null;
      
      // 解析不同格式的订单数据
      if (message.data && message.data.e === 'executionReport') {
        orderData = message.data;
      } else if (message.e === 'executionReport') {
        orderData = message;
      } else if (message.data) {
        orderData = message.data;
      } else {
        orderData = message;
      }
      
      if (orderData) {
        // 记录重要的订单状态变化
        const orderId = orderData.i || orderData.orderId || orderData.id;
        const status = orderData.X || orderData.status;
        const side = orderData.S || orderData.side;
        const symbol = orderData.s || orderData.symbol;
        const price = orderData.p || orderData.price;
        const quantity = orderData.q || orderData.quantity;
        const filledQuantity = orderData.z || orderData.filledQuantity || orderData.executedQty;
        
        // 只记录重要状态变化
        if (status === 'FILLED' || status === 'PARTIALLY_FILLED' || status === 'CANCELED') {
          this.logger.log(`🔄 订单状态更新: ${orderId} ${side} ${status} ${symbol} 价格:${price} 数量:${quantity} 成交:${filledQuantity}`);
        }
        
        // 调用外部回调处理订单更新
        if (typeof this.onOrderUpdate === 'function') {
          this.onOrderUpdate({
            orderId,
            status,
            side,
            symbol,
            price: parseFloat(price) || 0,
            quantity: parseFloat(quantity) || 0,
            filledQuantity: parseFloat(filledQuantity) || 0,
            rawData: orderData
          });
        }
      }
    } catch (error) {
      this.logger.log(`处理订单更新失败: ${error.message}`, true);
    }
  }
  
  /**
   * 🔑 处理余额更新
   */
  processBalanceUpdate(message) {
    try {
      let balanceData = null;
      
      // 解析不同格式的余额数据
      if (message.data && message.data.e === 'outboundAccountPosition') {
        balanceData = message.data;
      } else if (message.e === 'outboundAccountPosition') {
        balanceData = message;
      } else if (message.data) {
        balanceData = message.data;
      } else {
        balanceData = message;
      }
      
      if (balanceData && balanceData.B) {
        // 处理余额数组
        const balances = {};
        for (const balance of balanceData.B) {
          if (balance.a && (balance.f !== undefined || balance.l !== undefined)) {
            balances[balance.a] = {
              available: parseFloat(balance.f) || 0,
              locked: parseFloat(balance.l) || 0
            };
          }
        }
        
        // 调用外部回调处理余额更新
        if (typeof this.onBalanceUpdate === 'function' && Object.keys(balances).length > 0) {
          this.onBalanceUpdate(balances);
        }
      }
    } catch (error) {
      this.logger.log(`处理余额更新失败: ${error.message}`, true);
    }
  }
  
  /**
   * 处理价格数据
   * @param {Object} data - 价格数据
   * @param {string} symbol - 交易对符号
   * @param {Date} now - 当前时间
   */
  processPriceData(data, symbol, now) {
    try {
      // 极低频率记录原始数据以便调试
      if (Math.random() < this.priceSampleRate && this.debugMode) {
        this.logger.logToFile(`处理价格数据: ${JSON.stringify(data).substring(0, 200)}...`);
      }
      
      let tickerSymbol;
      let lastPrice;
      
      // 处理不同格式的数据 - 不再记录每种格式的处理过程
      if (data && data.data && data.data.s && data.data.c) {
        // Backpack 格式
        tickerSymbol = data.data.s;
        lastPrice = parseFloat(data.data.c);
      } else if (data && data.s && data.c) {
        // Binance 格式
        tickerSymbol = data.s;
        lastPrice = parseFloat(data.c);
      } else if (data && data.symbol && data.price) {
        // 标准格式
        tickerSymbol = data.symbol;
        lastPrice = parseFloat(data.price);
      } else if (data && data.data && typeof data.data === 'object') {
        // 尝试从data字段中提取
        const nestedData = data.data;
        if (nestedData.s && nestedData.c) {
          tickerSymbol = nestedData.s;
          lastPrice = parseFloat(nestedData.c);
        } else if (nestedData.symbol && nestedData.price) {
          tickerSymbol = nestedData.symbol;
          lastPrice = parseFloat(nestedData.price);
        }
      } else if (data && data.result && data.result.data) {
        // Backpack可能的另一种格式
        const resultData = data.result.data;
        if (Array.isArray(resultData) && resultData.length > 0) {
          const firstItem = resultData[0];
          if (firstItem.s && firstItem.c) {
            tickerSymbol = firstItem.s;
            lastPrice = parseFloat(firstItem.c);
          }
        }
      } else {
        // 未知格式 - 低频率记录
        if (Math.random() < 0.05 && this.debugMode) {
          this.logger.logToFile(`未识别的数据格式: ${JSON.stringify(data).substring(0, 100)}...`);
        }
        return;
      }
      
      // 处理提取到的价格和符号
      if (tickerSymbol && !isNaN(lastPrice) && lastPrice > 0) {
        // 不再每次都记录成功提取的数据
        
        // 标准化符号格式
        const normalizedSymbol = symbol.replace('-', '_').toUpperCase();
        const normalizedTickerSymbol = tickerSymbol.replace('-', '_').toUpperCase();
        
        // 确认交易对匹配
        if (normalizedTickerSymbol.includes(normalizedSymbol) || normalizedSymbol.includes(normalizedTickerSymbol)) {
          this.handlePriceUpdate(tickerSymbol, lastPrice, symbol, now);
        } else if (this.debugMode) {
          this.logger.logToFile(`交易对不匹配: 收到=${normalizedTickerSymbol}, 订阅=${normalizedSymbol}`);
        }
      } else if (this.debugMode) {
        this.logger.logToFile(`提取的价格数据无效: 交易对=${tickerSymbol}, 价格=${lastPrice}`);
      }
    } catch (error) {
      this.logger.log(`处理价格数据出错: ${error.message}`);
    }
  }
  
  /**
   * 🔑 创建认证签名用于私有WebSocket订阅
   * @param {string} timestamp - 时间戳
   * @param {string} instruction - 指令字符串
   * @returns {string} 签名
   */
  createSignature(timestamp, instruction) {
    if (!this.privateKey) {
      throw new Error('私钥未设置，无法创建认证签名');
    }
    
    try {
      // 解码私钥
      const rawPrivate = Buffer.from(this.privateKey, "base64").subarray(0, 32);
      const prefixPrivateEd25519 = Buffer.from("302e020100300506032b657004220420", "hex");
      const der = Buffer.concat([prefixPrivateEd25519, rawPrivate]);
      const privateKeyObj = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      
      // 创建签名数据
      const signData = `instruction=${instruction}&timestamp=${timestamp}`;
      const signature = crypto.sign(null, Buffer.from(signData), privateKeyObj);
      
      return Buffer.from(signature).toString('base64');
    } catch (error) {
      this.logger.log(`创建签名失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 🔑 订阅私有订单更新流
   */
  subscribeOrderUpdates() {
    if (!this.connectionActive || !this.ws) {
      this.logger.log('WebSocket未连接，无法订阅订单更新');
      return false;
    }
    
    if (!this.privateKey || !this.publicKey) {
      this.logger.log('缺少API密钥，无法订阅私有订单更新');
      return false;
    }
    
    try {
      const timestamp = Date.now().toString();
      const instruction = 'subscribe';
      const signature = this.createSignature(timestamp, instruction);
      
      const subscribeMsg = {
        method: "SUBSCRIBE",
        params: ["orderUpdate"],
        id: Date.now(),
        signature: signature,
        timestamp: timestamp,
        instruction: instruction,
        publicKey: this.publicKey
      };
      
      this.ws.send(JSON.stringify(subscribeMsg));
      this.logger.log('已订阅私有订单更新流');
      
      return true;
    } catch (error) {
      this.logger.log(`订阅订单更新失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 订阅行情频道
   * @param {string} symbol - 交易对符号
   */
  subscribeTicker(symbol) {
    if (!this.connectionActive || !this.ws) {
      this.logger.log('WebSocket未连接，无法订阅行情');
      return false;
    }
    
    try {
      // 确保使用正确的格式
      const formattedSymbol = symbol.toUpperCase();
      
      // 使用多种订阅格式提高成功率
      const subscriptions = [
        // 标准格式
        {
          method: "SUBSCRIBE",
          params: [`ticker.${formattedSymbol}`],
          id: Date.now()
        },
        // 备用格式
        {
          method: "SUBSCRIBE",
          params: [`ticker@${formattedSymbol.replace('_', '')}`],
          id: Date.now() + 1
        },
        // 再一种备用格式
        {
          op: "subscribe",
          channel: "ticker",
          market: formattedSymbol,
          id: Date.now() + 2
        }
      ];
      
      // 发送所有订阅格式 - 不再记录每个订阅请求详情
      for (const sub of subscriptions) {
        this.ws.send(JSON.stringify(sub));
      }
      
      // 请求立即获取一次价格
      const getTickerMsg = {
        method: "GET_TICKER",
        params: {
          symbol: formattedSymbol
        },
        id: Date.now() + 3
      };
      this.ws.send(JSON.stringify(getTickerMsg));
      
      this.logger.log(`已订阅行情: ${formattedSymbol}`);
      
      return true;
    } catch (error) {
      this.logger.log(`订阅行情失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 设置心跳
   */
  setupHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.connectionActive) {
        try {
          // 发送心跳消息
          const pingMsg = JSON.stringify({ "op": "ping" });
          this.ws.send(pingMsg);
          
          // 完全不记录心跳信息
        } catch (error) {
          // 心跳失败是重要错误，保留在终端输出
          this.logger.log(`发送心跳失败: ${error.message}`);
        }
      }
    }, 30000); // 每30秒发送一次心跳
  }
  
  /**
   * 关闭WebSocket连接
   */
  closeWebSocket() {
    // 标记连接状态为非活动
    this.connectionActive = false;
    
    // 清理心跳
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // 清理重连定时器
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // 关闭连接
    if (this.ws) {
      try {
        // 先尝试优雅地关闭
        if (this.ws.readyState === 1) { // 如果连接是打开状态
          // 先移除所有事件监听
          this.ws.removeAllListeners();
          
          // 发送关闭消息
          try {
            const closeMsg = JSON.stringify({ "op": "close" });
            this.ws.send(closeMsg);
          } catch (sendError) {
            // 发送关闭消息失败可以忽略
          }
          
          // 注册一次性关闭事件以确认关闭
          this.ws.once('close', () => {
            this.logger.log('WebSocket连接已正常关闭');
          });
          
          // 正常关闭
          this.ws.close();
        }
        
        // 无论上面是否成功，都确保连接被终止
        setTimeout(() => {
          if (this.ws) {
            this.ws.terminate();
            this.ws = null;
            this.logger.log('WebSocket连接已强制终止');
          }
        }, 1000);
        
      } catch (error) {
        this.logger.log(`关闭WebSocket连接失败: ${error.message}`, true);
        
        // 确保在发生错误时仍然清理资源
        try {
          this.ws.terminate();
        } catch (terminateError) {
          // 忽略终止时的错误
        } finally {
          this.ws = null;
          this.logger.log('已强制清理WebSocket资源');
        }
      }
    }
  }
  
  /**
   * 获取连接状态
   * @returns {boolean} 是否已连接
   */
  isConnected() {
    return this.connectionActive;
  }
  
  /**
   * 处理价格更新
   * @param {string} tickerSymbol - 交易对符号
   * @param {number} lastPrice - 最新价格
   * @param {string} symbol - 订阅的原始交易对符号
   * @param {Date} now - 当前时间
   */
  handlePriceUpdate(tickerSymbol, lastPrice, symbol, now) {
    try {
      // 避免处理无效数据
      if (!tickerSymbol || !lastPrice || isNaN(lastPrice) || lastPrice <= 0) {
        return;
      }
      
      // 显著价格变化或首次接收价格数据时在终端显示
      // 提高显著变化阈值，减少输出频率
      const hasSignificantChange = this.previousPrice && 
        Math.abs(lastPrice - this.previousPrice) / this.previousPrice > 0.005; // 0.5%的变化
      
      if (hasSignificantChange || !this.previousPrice) {
        // 只在首次接收或有明显变化时在终端显示
        if (!this.previousPrice) {
          this.logger.log(`首次接收价格数据: ${lastPrice} USDC`);
        } else if (hasSignificantChange) {
          const changePercent = ((lastPrice - this.previousPrice) / this.previousPrice) * 100;
          // 只有大于0.5%的变化才显示
          if (Math.abs(changePercent) > 0.5) {
            this.logger.log(`价格变动: ${lastPrice} USDC (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
          }
        }
      } else if (Math.random() < 0.001) { 
        // 极低频率记录到日志文件，千分之一概率
        const timeStr = now.toLocaleTimeString();
        this.logger.logToFile(`${timeStr} - ${tickerSymbol}: ${lastPrice}`);
      }
      
      // 更新最后成功接收的价格数据
      this.lastPriceData = {
        symbol: tickerSymbol,
        price: lastPrice,
        time: now
      };
      
      this.previousPrice = lastPrice;
      
      // 通知外部回调 - 不再记录每次调用
      if (typeof this.onPriceUpdate === 'function') {
        try {
          this.onPriceUpdate(tickerSymbol, lastPrice, now);
          // 不再记录每次回调成功
        } catch (callbackError) {
          this.logger.log(`调用价格回调函数失败: ${callbackError.message}`);
        }
      } else if (!this.onPriceUpdateWarningDisplayed) {
        // 只显示一次警告
        this.logger.log(`警告: onPriceUpdate回调未设置或不是函数`);
        this.onPriceUpdateWarningDisplayed = true;
      }
    } catch (error) {
      this.logger.log(`处理价格更新失败: ${error.message}`);
    }
  }
  
  /**
   * 关闭所有WebSocket连接并清理资源
   */
  closeAllConnections() {
    this.logger.log('正在关闭所有WebSocket连接和清理资源...');
    
    // 关闭主WebSocket连接
    this.closeWebSocket();
    
    // 清理所有计时器
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // 强制关闭WebSocket连接
    if (this.ws) {
      try {
        // 尝试正常关闭
        if (this.ws.readyState === 1) { // OPEN
          this.ws.close();
        }
        
        // 强制终止连接
        this.ws.terminate();
        this.logger.log('WebSocket连接已强制终止');
      } catch (error) {
        this.logger.log(`强制关闭WebSocket连接时出错: ${error.message}`, true);
      } finally {
        // 确保引用被清除
        this.ws = null;
      }
    }
    
    // 重置状态
    this.connectionActive = false;
    this.lastPriceData = null;
    this.previousPrice = null;
    
    this.logger.log('所有WebSocket连接已关闭并清理完成');
  }
}

module.exports = WebSocketManager; 