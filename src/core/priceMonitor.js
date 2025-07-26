const WebSocketManager = require('../network/webSocketManager');
const { log } = require('../utils/logger');
const TimeUtils = require('../utils/timeUtils');

/**
 * 价格监控类 - 负责监控价格变化和触发事件
 */
class PriceMonitor {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 全局配置
   * @param {Function} options.onPriceUpdate - 价格更新回调
   * @param {Function} options.onPriceData - 价格数据收到回调
   * @param {Object} options.logger - 日志记录器
   */
  constructor(options = {}) {
    this.config = options.config;
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    this.onPriceData = options.onPriceData || (() => {});
    this.onOrderUpdate = options.onOrderUpdate || (() => {}); // 🔑 添加订单更新回调
    this.logger = options.logger;
    
    // 初始化WebSocket管理器
    this.wsManager = new WebSocketManager({
      wsUrl: this.config?.websocket?.url || 'wss://ws.backpack.exchange',
      config: this.config,
      onMessage: this.handleMessage.bind(this),
      onPriceUpdate: this.handleWebSocketPriceUpdate.bind(this),
      onOrderUpdate: this.handleOrderUpdate.bind(this), // 🔑 添加订单更新回调
      logger: this.logger
    });
    
    // 测试回调是否正确设置
    if (typeof this.wsManager.onPriceUpdate !== 'function') {
      this.logger?.log('警告: WebSocketManager.onPriceUpdate 未正确设置');
    } else {
      this.logger?.log('WebSocketManager.onPriceUpdate 已正确设置');
    }
    
    // 价格数据
    this.lastPrice = 0;
    this.currentPrice = 0;
    this.priceSource = 'WebSocket';
    this.lastUpdateTime = null;
    
    // 监控状态
    this.monitoring = false;
    this.symbol = null;
    this.checkInterval = null;
    
    // 添加重试计数
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }
  
  /**
   * 启动价格监控
   * @param {string} symbol - 交易对符号
   * @returns {boolean} 是否成功启动
   */
  startMonitoring(symbol) {
    if (this.monitoring) {
      log(`已经在监控 ${this.symbol} 的价格`);
      return true;
    }
    
    this.symbol = symbol;
    this.monitoring = true;
    this.startMonitoringTime = Date.now();  // 添加监控开始时间
    this.reconnectAttempts = 0;  // 重置重连计数
    
    // 确保symbol使用正确的格式
    // 不做转换，直接使用相同的格式
    log(`原始交易对: ${symbol}`);
    
    // 关闭现有的WebSocket连接
    if (this.wsManager) {
      this.wsManager.closeWebSocket();
    }
    
    // 重新初始化WebSocketManager以确保回调函数正确设置
    this.wsManager = new WebSocketManager({
      wsUrl: this.config?.websocket?.url || 'wss://ws.backpack.exchange',
      config: this.config,
      onMessage: this.handleMessage.bind(this),
      onPriceUpdate: this.handleWebSocketPriceUpdate.bind(this),
      onOrderUpdate: this.handleOrderUpdate.bind(this), // 🔑 添加订单更新回调
      logger: this.logger
    });
    
    // 启动WebSocket
    log(`启动对 ${symbol} 的价格监控...`);
    const websocket = this.wsManager.setupPriceWebSocket(symbol);
    
    // 启动定期检查，确保价格数据正常
    this.startPeriodicCheck();
    
    return websocket !== null;
  }
  
  /**
   * 停止价格监控
   */
  stopMonitoring() {
    if (!this.monitoring) return;
    
    this.logger?.log('停止价格监控...');
    
    // 停止WebSocket，确保连接关闭
    if (this.wsManager) {
      try {
        // 先关闭WebSocket连接
        this.wsManager.closeWebSocket();
        
        // 关闭所有连接，彻底清理资源
        this.wsManager.closeAllConnections();
        this.logger?.log('已关闭所有WebSocket连接');
      } catch (error) {
        this.logger?.log(`关闭WebSocket连接时出错: ${error.message}`, true);
      }
    }
    
    // 清除定期检查
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // 重置状态
    this.monitoring = false;
    this.symbol = null;
    this.lastPrice = 0;
    this.currentPrice = 0;
    this.lastUpdateTime = null;
    this.reconnectAttempts = 0;
    
    this.logger?.log('价格监控已完全停止');
  }
  
  /**
   * 启动定期检查
   */
  startPeriodicCheck() {
    // 清除现有的定期检查
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    
    // 每15秒检查一次价格数据状态，降低间隔增加及时性
    this.checkInterval = setInterval(() => {
      this.checkPriceDataStatus();
    }, 15000);
    
    // 首次启动时立即执行一次检查
    setTimeout(() => {
      this.checkPriceDataStatus();
    }, 5000);
  }
  
  /**
   * 检查价格数据状态
   */
  checkPriceDataStatus() {
    if (!this.monitoring) return;
    
    const now = Date.now();
    
    // 如果有上次更新时间，检查价格数据是否过时
    if (this.lastUpdateTime) {
      const dataAge = now - this.lastUpdateTime;
      
      // 如果价格数据超过30秒未更新，记录警告并尝试重连
      if (dataAge > 30000) {
        this.logger.log(`警告: 价格数据已 ${Math.floor(dataAge / 1000)} 秒未更新`, true);
        
        // 如果WebSocket未连接或数据太旧，尝试重连
        if (!this.wsManager.isConnected() || dataAge > 60000) {
          this.reconnectAttempts++;
          this.logger.log(`尝试重新连接WebSocket... (尝试 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          
          // 如果超过最大重试次数，尝试通过API获取价格
          if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this.logger.log('WebSocket重连失败次数过多，尝试通过API获取价格');
            this.fetchPriceFromApi();
          } else {
            this.wsManager.setupPriceWebSocket(this.symbol);
          }
        }
      }
    } else {
      // 如果没有上次更新时间，可能是首次启动或数据未初始化
      this.logger.log('等待首次价格数据更新...');
      
      // 如果启动后5秒还没有收到数据，尝试通过API获取价格
      if (now - this.startMonitoringTime > 5000) {
        this.logger.log('WebSocket数据延迟，尝试通过API获取初始价格');
        this.fetchPriceFromApi();
      }
    }
  }
  
  /**
   * 处理WebSocket消息
   * @param {Object} data - 消息数据
   */
  handleMessage(data) {
    try {
      // 只有0.1%的消息会被记录到日志文件，大幅减少日志量
      if (Math.random() < 0.001 && typeof this.logger?.logToFile === 'function') {
        this.logger.logToFile(`收到WebSocket消息: ${JSON.stringify(data).substring(0, 200)}...`);
      }
      
      // 将原始消息传递给外部处理函数
      if (typeof this.onPriceData === 'function') {
        this.onPriceData(data);
      }
    } catch (error) {
      if (typeof this.logger?.log === 'function') {
        this.logger.log(`处理WebSocket消息失败: ${error.message}`);
      } else {
        console.log(`处理WebSocket消息失败: ${error.message}`);
      }
    }
  }
  
  /**
   * 处理WebSocket价格更新回调
   * @param {string} symbol - 交易对符号
   * @param {number} price - 价格
   * @param {Date} time - 时间戳
   */
  handleWebSocketPriceUpdate(symbol, price, time) {
    try {
      // 确保参数有效
      if (!symbol || !price || isNaN(price) || price <= 0) {
        this.logger?.log(`收到无效的WebSocket价格更新: symbol=${symbol}, price=${price}`);
        return;
      }
      
      // 只在首次接收或价格变化显著时(超过0.5%)才记录
      const significantChange = this.currentPrice && (Math.abs(price - this.currentPrice) / this.currentPrice) > 0.005;
      const isFirstUpdate = !this.currentPrice || this.currentPrice <= 0;
      
      if (isFirstUpdate || significantChange) {
        const changeText = isFirstUpdate ? "" : `(${((price - this.currentPrice) / this.currentPrice * 100).toFixed(2)}%)`;
        this.logger?.log(`价格更新: ${symbol} = ${price} USDC ${changeText}`);
      }
      
      // 更新内部状态
      this.lastPrice = this.currentPrice;
      this.currentPrice = price;
      this.lastUpdateTime = time ? time.getTime() : Date.now();
      
      // 构建价格信息对象
      const priceInfo = {
        price,
        symbol: symbol || this.symbol,
        source: 'WebSocket',
        updateTime: this.lastUpdateTime,
        change: this.lastPrice > 0 ? ((price - this.lastPrice) / this.lastPrice) * 100 : 0
      };
      
      // 只在调试模式下或价格变化显著时记录到日志文件
      if (significantChange || Math.random() < 0.001) {
        this.logger?.logToFile(`WebSocket价格更新: ${JSON.stringify(priceInfo)}`);
      }
      
      // 将价格信息传递给外部处理函数
      if (typeof this.onPriceUpdate === 'function') {
        try {
          this.onPriceUpdate(priceInfo);
          // 不再记录每次回调成功
        } catch (callbackError) {
          this.logger?.log(`调用价格回调函数失败: ${callbackError.message}`);
        }
      }
    } catch (error) {
      this.logger?.log(`处理WebSocket价格回调失败: ${error.message}`);
    }
  }
  
  /**
   * 处理价格更新
   * @param {number} price - 价格
   * @param {string} symbol - 交易对符号
   */
  handlePriceUpdate(price, symbol) {
    try {
      if (!this.isPriceValid(price)) {
        return;
      }
      
      // 计算价格变化百分比
      const previousPrice = this.currentPrice;
      const priceChangePercent = previousPrice ? ((price - previousPrice) / previousPrice) * 100 : 0;
      
      // 提高阈值，价格变化超过0.5%时才在终端显示
      if (Math.abs(priceChangePercent) > 0.5) {
        this.logger?.log(`价格更新: ${price} USDC (${priceChangePercent > 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%)`);
      }
      
      // 更新价格状态
      this.lastPrice = this.currentPrice;
      this.currentPrice = price;
      this.lastUpdateTime = Date.now();
      
      // 构建价格信息对象
      const priceInfo = {
        price,
        symbol: symbol || this.symbol,
        source: this.priceSource,
        updateTime: this.lastUpdateTime,
        change: priceChangePercent
      };
      
      // 只在有显著价格变化或极低概率随机记录时才记录详细信息
      if (Math.abs(priceChangePercent) > 0.5 || Math.random() < 0.001) {
        this.logger?.logToFile(`价格信息: ${JSON.stringify(priceInfo)}`);
      }
      
      // 将价格信息传递给外部处理函数
      if (typeof this.onPriceUpdate === 'function') {
        this.onPriceUpdate(priceInfo);
      }
    } catch (error) {
      this.logger?.log(`处理价格更新失败: ${error.message}`);
    }
  }
  
  /**
   * 获取当前价格信息
   * @returns {Object|null} 价格信息对象或null
   */
  getCurrentPriceInfo() {
    if (!this.currentPrice || this.currentPrice <= 0) {
      return null;
    }
    
    return {
      price: this.currentPrice,
      symbol: this.symbol,
      source: this.priceSource,
      updateTime: this.lastUpdateTime
    };
  }
  
  /**
   * 检查价格数据是否有效
   * @param {number} timeoutSeconds - 超时秒数
   * @returns {boolean} 是否有效
   */
  isPriceDataValid(timeoutSeconds = 60) {
    if (!this.currentPrice || this.currentPrice <= 0 || !this.lastUpdateTime) {
      return false;
    }
    
    const dataAge = (Date.now() - this.lastUpdateTime) / 1000;
    return dataAge <= timeoutSeconds;
  }
  
  /**
   * 是否正在监控
   * @returns {boolean} 是否正在监控
   */
  isMonitoring() {
    return this.monitoring;
  }

  /**
   * 处理WebSocket消息
   * @param {number} price - 最新价格
   */
  handleWebSocketMessage(price) {
    if (!this.isPriceValid(price)) {
      // 这是异常情况，应保留在终端显示
      if (Math.random() < 0.1) {
        this.logger.logToFile(`收到无效的价格数据: ${price}`);
      }
      return;
    }
    
    // 首次收到价格数据
    if (!this.priceData) {
      // 首次收到数据是重要事件，保留在终端
      this.logger.log(`首次收到价格数据: ${price}`);
    }
    
    // 保存有效的价格数据
    const previousPrice = this.priceData ? this.priceData.price : 0;
    
    this.priceData = {
      price,
      source: 'WebSocket',
      updateTime: new Date(),
      increase: previousPrice > 0 ? ((price - previousPrice) / previousPrice) * 100 : 0
    };
    
    // 触发价格更新事件
    if (typeof this.onPriceUpdate === 'function') {
      this.onPriceUpdate(this.priceData);
    }
  }
  
  /**
   * 验证价格数据是否有效
   * @param {number} price - 价格
   * @returns {boolean} 是否有效
   */
  isPriceValid(price) {
    // 价格必须是有效数字且大于0
    return !isNaN(price) && Number.isFinite(price) && price > 0;
  }

  /**
   * 🔑 处理订单状态更新回调
   * @param {Object} orderUpdate - 订单更新数据
   */
  handleOrderUpdate(orderUpdate) {
    try {
      // 记录重要的订单状态变化
      this.logger?.log(`🔄 收到订单状态更新: ${orderUpdate.orderId} ${orderUpdate.status}`);
      
      // 将订单更新传递给外部处理函数（主应用）
      if (typeof this.onOrderUpdate === 'function') {
        this.onOrderUpdate(orderUpdate);
      }
    } catch (error) {
      this.logger?.log(`处理订单更新回调失败: ${error.message}`, true);
    }
  }
  
  /**
   * 从API获取价格
   */
  async fetchPriceFromApi() {
    try {
      if (!this.config || !this.symbol) {
        this.logger.log('无法从API获取价格: 配置或交易对未定义');
        return;
      }
      
      // 这里可以使用BackpackService获取价格，但简单演示就直接获取
      this.logger.log(`尝试从API获取${this.symbol}价格...`);
      
      // 使用Node.js内置的https模块
      const https = require('https');
      const symbol = this.symbol.replace('_', '');
      const url = `https://api.backpack.exchange/api/v1/ticker/price?symbol=${symbol}`;
      
      // 使用Promise封装HTTP请求
      const response = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let data = '';
          
          // 接收数据片段
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          // 接收完成
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsedData = JSON.parse(data);
                resolve(parsedData);
              } catch (e) {
                reject(new Error(`解析JSON失败: ${e.message}`));
              }
            } else {
              reject(new Error(`API请求失败: ${res.statusCode} ${res.statusMessage}`));
            }
          });
        }).on('error', (e) => {
          reject(new Error(`请求失败: ${e.message}`));
        });
      });
      
      if (response && response.price) {
        const price = parseFloat(response.price);
        this.logger.log(`API获取价格成功: ${price} USDC`);
        
        // 更新价格数据
        this.handlePriceUpdate(price, this.symbol);
      } else {
        throw new Error('API返回的数据格式不正确');
      }
    } catch (error) {
      this.logger.log(`从API获取价格失败: ${error.message}`);
    }
  }
}

module.exports = PriceMonitor; 