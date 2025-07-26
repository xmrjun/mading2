const EventEmitter = require('events');
const { defaultLogger } = require('../utils/logger');

/**
 * 状态管理器 - 统一管理所有交易数据的单一数据源
 * WebSocket优先，API作为备用和关键操作
 */
class StateManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = config;
    this.logger = config.logger || defaultLogger;
    
    // 核心状态数据
    this.state = {
      // 价格数据
      price: {
        current: 0,
        symbol: null,
        lastUpdate: null,
        source: null,
        change24h: 0
      },
      
      // 账户余额
      balances: new Map(), // coin -> { available, total, lastUpdate }
      
      // 订单状态  
      orders: new Map(), // orderId -> { ...orderData, lastUpdate, source }
      
      // 持仓信息
      positions: new Map(), // symbol -> { quantity, avgPrice, lastUpdate }
      
      // 连接状态
      connections: {
        websocket: false,
        api: true, // API总是可用的
        lastWebSocketConnect: null,
        reconnectAttempts: 0
      },
      
      // 数据新鲜度控制
      dataAge: {
        maxPriceAge: 30000,    // 30秒
        maxBalanceAge: 10000,  // 10秒  
        maxOrderAge: 5000,     // 5秒
        maxPositionAge: 15000  // 15秒
      }
    };
    
    // 数据更新统计
    this.stats = {
      priceUpdates: 0,
      balanceUpdates: 0,
      orderUpdates: 0,
      apiCalls: 0,
      websocketMessages: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }
  
  /**
   * 获取当前价格数据
   * @returns {Object} 价格信息
   */
  getPriceData() {
    const price = this.state.price;
    
    // 检查数据新鲜度
    if (price.lastUpdate && Date.now() - price.lastUpdate > this.state.dataAge.maxPriceAge) {
      this.logger.log('警告: 价格数据已过期');
      this.emit('dataStale', { type: 'price', age: Date.now() - price.lastUpdate });
    }
    
    return { ...price };
  }
  
  /**
   * 更新价格数据
   * @param {number} newPrice 新价格
   * @param {string} symbol 交易对
   * @param {string} source 数据源 ('websocket' | 'api')
   * @param {Object} metadata 元数据
   */
  updatePrice(newPrice, symbol, source = 'unknown', metadata = {}) {
    if (!newPrice || newPrice <= 0) {
      this.logger.log(`价格数据无效: ${newPrice}`);
      return false;
    }
    
    const now = Date.now();
    const oldPrice = this.state.price.current;
    
    // 更新价格状态
    this.state.price = {
      current: newPrice,
      symbol: symbol,
      lastUpdate: now,
      source: source,
      change24h: metadata.change24h || 0,
      ...metadata
    };
    
    this.stats.priceUpdates++;
    
    // 计算变化百分比
    const changePercent = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
    
    // 发出价格更新事件
    this.emit('priceUpdate', {
      price: newPrice,
      symbol: symbol,
      change: changePercent,
      source: source,
      timestamp: now
    });
    
    // 只在显著变化时记录日志
    if (Math.abs(changePercent) > 0.1 || !oldPrice) {
      this.logger.log(`💰 价格更新: ${newPrice} USDC (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%) [${source}]`);
    }
    
    return true;
  }
  
  /**
   * 获取余额数据
   * @param {string} coin 币种
   * @returns {Object} 余额信息
   */
  getBalance(coin) {
    const balance = this.state.balances.get(coin);
    
    if (!balance) {
      this.stats.cacheMisses++;
      return { available: 0, total: 0, lastUpdate: null, source: null };
    }
    
    // 检查数据新鲜度
    if (Date.now() - balance.lastUpdate > this.state.dataAge.maxBalanceAge) {
      this.logger.log(`警告: ${coin}余额数据已过期`);
      this.emit('dataStale', { type: 'balance', coin: coin, age: Date.now() - balance.lastUpdate });
    } else {
      this.stats.cacheHits++;
    }
    
    return { ...balance };
  }
  
  /**
   * 更新余额数据
   * @param {string} coin 币种
   * @param {Object} balanceData 余额数据
   * @param {string} source 数据源
   */
  updateBalance(coin, balanceData, source = 'api') {
    const now = Date.now();
    
    const balance = {
      available: parseFloat(balanceData.available || balanceData.free || 0),
      total: parseFloat(balanceData.total || balanceData.balance || balanceData.available || 0),
      locked: parseFloat(balanceData.locked || 0),
      lastUpdate: now,
      source: source
    };
    
    this.state.balances.set(coin, balance);
    this.stats.balanceUpdates++;
    
    this.emit('balanceUpdate', {
      coin: coin,
      balance: balance,
      source: source,
      timestamp: now
    });
    
    this.logger.log(`💳 余额更新: ${coin} 可用=${balance.available} 总计=${balance.total} [${source}]`);
    
    return true;
  }
  
  /**
   * 获取订单状态
   * @param {string} orderId 订单ID
   * @returns {Object} 订单信息
   */
  getOrder(orderId) {
    const order = this.state.orders.get(String(orderId));
    
    if (!order) {
      this.stats.cacheMisses++;
      return null;
    }
    
    // 检查数据新鲜度
    if (Date.now() - order.lastUpdate > this.state.dataAge.maxOrderAge) {
      this.logger.log(`警告: 订单${orderId}数据已过期`);
      this.emit('dataStale', { type: 'order', orderId: orderId, age: Date.now() - order.lastUpdate });
    } else {
      this.stats.cacheHits++;
    }
    
    return { ...order };
  }
  
  /**
   * 更新订单状态
   * @param {string} orderId 订单ID
   * @param {Object} orderData 订单数据
   * @param {string} source 数据源
   */
  updateOrder(orderId, orderData, source = 'api') {
    const now = Date.now();
    const orderIdStr = String(orderId);
    
    const order = {
      ...orderData,
      orderId: orderIdStr,
      lastUpdate: now,
      source: source
    };
    
    this.state.orders.set(orderIdStr, order);
    this.stats.orderUpdates++;
    
    this.emit('orderUpdate', {
      orderId: orderIdStr,
      order: order,
      source: source,
      timestamp: now
    });
    
    // 重要状态变化才记录日志
    const status = orderData.status || orderData.X;
    if (['FILLED', 'CANCELED', 'PARTIALLY_FILLED'].includes(status)) {
      this.logger.log(`📋 订单更新: ${orderIdStr} ${status} [${source}]`);
    }
    
    return true;
  }
  
  /**
   * 获取所有未成交订单
   * @returns {Array} 未成交订单列表
   */
  getOpenOrders() {
    const openOrders = [];
    
    for (const [orderId, order] of this.state.orders) {
      if (['NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(order.status || order.X)) {
        // 检查数据新鲜度
        if (Date.now() - order.lastUpdate <= this.state.dataAge.maxOrderAge) {
          openOrders.push({ ...order });
          this.stats.cacheHits++;
        } else {
          this.stats.cacheMisses++;
        }
      }
    }
    
    return openOrders;
  }
  
  /**
   * 移除订单（已成交或取消）
   * @param {string} orderId 订单ID
   */
  removeOrder(orderId) {
    const orderIdStr = String(orderId);
    const removed = this.state.orders.delete(orderIdStr);
    
    if (removed) {
      this.emit('orderRemoved', { orderId: orderIdStr, timestamp: Date.now() });
      this.logger.log(`🗑️ 订单已移除: ${orderIdStr}`);
    }
    
    return removed;
  }
  
  /**
   * 更新WebSocket连接状态
   * @param {boolean} connected 是否连接
   */
  updateWebSocketStatus(connected) {
    const wasConnected = this.state.connections.websocket;
    this.state.connections.websocket = connected;
    
    if (connected && !wasConnected) {
      this.state.connections.lastWebSocketConnect = Date.now();
      this.state.connections.reconnectAttempts = 0;
      this.logger.log('🔌 WebSocket已连接');
      this.emit('websocketConnected');
    } else if (!connected && wasConnected) {
      this.state.connections.reconnectAttempts++;
      this.logger.log('🔌 WebSocket已断开');
      this.emit('websocketDisconnected');
    }
  }
  
  /**
   * 检查数据源健康状态
   * @returns {Object} 健康状态报告
   */
  getHealthStatus() {
    const now = Date.now();
    const price = this.state.price;
    
    return {
      websocket: {
        connected: this.state.connections.websocket,
        lastConnect: this.state.connections.lastWebSocketConnect,
        reconnectAttempts: this.state.connections.reconnectAttempts
      },
      data: {
        priceAge: price.lastUpdate ? now - price.lastUpdate : null,
        priceValid: price.lastUpdate && (now - price.lastUpdate) < this.state.dataAge.maxPriceAge,
        balanceCount: this.state.balances.size,
        orderCount: this.state.orders.size
      },
      stats: { ...this.stats },
      performance: {
        cacheHitRate: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) || 0,
        avgPriceUpdateInterval: this.stats.priceUpdates > 0 ? (now - (this.state.connections.lastWebSocketConnect || 0)) / this.stats.priceUpdates : 0
      }
    };
  }
  
  /**
   * 清理过期数据
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // 清理过期订单
    for (const [orderId, order] of this.state.orders) {
      if (now - order.lastUpdate > 300000) { // 5分钟过期
        this.state.orders.delete(orderId);
        cleaned++;
      }
    }
    
    // 清理过期余额
    for (const [coin, balance] of this.state.balances) {
      if (now - balance.lastUpdate > 600000) { // 10分钟过期
        this.state.balances.delete(coin);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger.log(`🧹 清理了${cleaned}条过期数据`);
    }
    
    return cleaned;
  }
  
  /**
   * 重置统计数据
   */
  resetStats() {
    this.stats = {
      priceUpdates: 0,
      balanceUpdates: 0,
      orderUpdates: 0,
      apiCalls: 0,
      websocketMessages: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }
  
  /**
   * 获取调试信息
   * @returns {Object} 调试信息
   */
  getDebugInfo() {
    return {
      state: {
        price: this.state.price,
        balanceCount: this.state.balances.size,
        orderCount: this.state.orders.size,
        connections: this.state.connections
      },
      stats: this.stats,
      health: this.getHealthStatus()
    };
  }
}

module.exports = StateManager;