const { Logger } = require('./src/utils/logger');
const BackpackService = require('./src/services/backpackService');
const ConfigLoader = require('./src/config/configLoader');
const WebSocketManager = require('./src/network/webSocketManager');

/**
 * 🎯 完整马丁策略交易器 - 完美运行版本
 * 
 * 马丁策略核心逻辑:
 * 1. 创建5个递增订单 (按配置: 总投资1000 USDC, 3%价格区间, 25%金额递增)
 * 2. WebSocket监控价格和订单状态
 * 3. 订单成交后自动计算平均成本
 * 4. 达到0.25%止盈自动卖出
 * 5. 卖出后自动重新开始新周期
 * 6. 3分钟无成交重新挂单 + 价格偏差0.3%重新挂单
 */

class MartingaleTrader {
  constructor() {
    this.logger = new Logger({
      logDir: './logs',
      prefix: 'martingale'
    });
    
    this.config = null;
    this.service = null;
    this.wsManager = null;
    
    // 马丁策略状态
    this.currentPrice = 0;
    this.lastPriceUpdate = 0;
    this.strategyStartPrice = 0;
    
    // 余额状态
    this.solBalance = 0;
    this.usdcBalance = 0;
    
    // 订单管理
    this.activeOrders = new Map(); // orderId -> {order, createTime}
    this.filledOrders = []; // 已成交订单历史
    this.isRunning = false;
    this.monitoring = false;
    
    // 🔑 止盈状态管理
    this.takeProfitInProgress = false;
    this.lastTakeProfitTime = 0;
    
    // 🔑 API调用队列管理
    this.apiQueue = [];
    this.apiQueueRunning = false;
    
    // 马丁参数 (从配置加载)
    this.totalAmount = 0;
    this.orderCount = 0;
    this.incrementPercent = 0;
    this.maxDropPercent = 0;
    this.takeProfitPercent = 0;
    this.noFillRestartMinutes = 3;
    this.maxPriceDifference = 0.3;
    this.minPositionValueThreshold = 50;
    
    // 🔑 简化持仓数据 - 直接存储，不依赖复杂数组
    this.positionCost = 0;        // 持仓总成本 USDC
    this.positionAvgPrice = 0;    // 持仓平均价格 USDC
    this.positionQuantity = 0;    // 持仓数量 SOL
    
    // 统计
    this.cycleCount = 0;
    this.totalProfit = 0;
  }
  
  /**
   * 🔧 价格格式化 - 严格确保2位小数，防止API 400错误
   */
  formatPrice(price) {
    // 先转换为字符串，确保精确的2位小数
    const formatted = parseFloat(price).toFixed(2);
    return parseFloat(formatted);
  }
  
  /**
   * 🔧 数量格式化 - 确保不超过实际可用余额，限制小数位数
   */
  formatQuantity(quantity, availableBalance = null) {
    // 如果提供了可用余额，确保不超过可用量
    if (availableBalance !== null && quantity > availableBalance) {
      // 保留足够的安全边距（0.1%），避免余额不足
      const safeQuantity = availableBalance * 0.999;
      // Backpack支持最多2位小数
      const formatted = parseFloat(safeQuantity).toFixed(2);
      return parseFloat(formatted);
    }
    
    // 默认保留2位小数精度（Backpack规范）
    const formatted = parseFloat(quantity).toFixed(2);
    return parseFloat(formatted);
  }
  
  async initialize() {
    try {
      // 加载配置
      const configInfo = ConfigLoader.loadConfig(__dirname);
      this.config = configInfo.config;
      
      // 🔑 加载马丁策略参数
      this.totalAmount = this.config.trading.totalAmount || 1000;
      this.orderCount = this.config.trading.orderCount || 5;
      this.incrementPercent = this.config.trading.incrementPercentage || 25;
      this.maxDropPercent = this.config.trading.maxDropPercentage || 3.0;
      this.takeProfitPercent = this.config.trading.takeProfitPercentage || 0.25;
      this.noFillRestartMinutes = this.config.advanced?.noFillRestartMinutes || 3;
      this.maxPriceDifference = this.config.advanced?.maxPriceDifference || 0.3;
      this.minPositionValueThreshold = this.config.advanced?.minPositionValueThreshold || 50;
      
      // 初始化服务
      this.service = new BackpackService(this.config, this.logger);
      
      const symbol = `${this.config.trading.tradingCoin}_USDC`;
      
      this.logger.log('🎯 === 马丁策略交易器启动 ===');
      this.logger.log(`交易对: ${symbol}`);
      this.logger.log(`🔑 马丁策略参数:`);
      this.logger.log(`  总投资: ${this.totalAmount} USDC`);
      this.logger.log(`  订单数: ${this.orderCount} 个`);
      this.logger.log(`  金额递增: ${this.incrementPercent}%`);
      this.logger.log(`  价格区间: ${this.maxDropPercent}%`);
      this.logger.log(`  止盈目标: ${this.takeProfitPercent}%`);
      this.logger.log(`  无成交重启: ${this.noFillRestartMinutes} 分钟`);
      this.logger.log(`  价格偏差阈值: ${this.maxPriceDifference}%`);
      this.logger.log(`  最小持仓价值阈值: $${this.minPositionValueThreshold}`);
      
      // 🔑 初始化WebSocket
      this.wsManager = new WebSocketManager({
        config: this.config,
        logger: this.logger,
        onPriceUpdate: (tickerSymbol, price, timestamp) => {
          this.handlePriceUpdate(price);
        },
        onOrderUpdate: (orderUpdate) => {
          this.handleOrderUpdate(orderUpdate);
        },
        onBalanceUpdate: (balances) => {
          this.handleBalanceUpdate(balances);
        }
      });
      
      return symbol;
    } catch (error) {
      this.logger.log(`初始化失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 🔑 安全API调用 - 激进限流减少API冲突
   */
  async safeApiCall(apiFunction, description) {
    try {
      // 🔑 优化限流 - 6秒间隔提高响应速度
      const minInterval = 6000;
      
      if (this.lastApiCall) {
        const timeSinceLastCall = Date.now() - this.lastApiCall;
        if (timeSinceLastCall < minInterval) {
          const waitTime = minInterval - timeSinceLastCall;
          this.logger.log(`⏳ API限流等待 ${Math.ceil(waitTime/1000)}秒...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      
      this.lastApiCall = Date.now();
      this.logger.log(`🔄 ${description}...`);
      
      const result = await apiFunction();
      this.logger.log(`✅ ${description} 成功`);
      return result;
      
    } catch (error) {
      this.logger.log(`❌ ${description} 失败: ${error.message}`, true);
      
      // 🔑 根据错误类型决定等待时间
      if (error.message.includes('429')) {
        this.logger.log('🚫 遇到API限流，等待1分钟...');
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else if (error.message.includes('400')) {
        this.logger.log('⚠️ 遇到API 400错误，等待15秒...');
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
      
      throw error;
    }
  }
  
  /**
   * 🔑 价格更新处理
   */
  handlePriceUpdate(price) {
    const oldPrice = this.currentPrice;
    this.currentPrice = this.formatPrice(price);
    this.lastPriceUpdate = Date.now();
    
    // 显著价格变化时记录
    if (oldPrice > 0 && Math.abs(this.currentPrice - oldPrice) / oldPrice > 0.01) {
      const change = ((this.currentPrice - oldPrice) / oldPrice * 100);
      this.logger.log(`💰 价格: ${this.currentPrice} USDC (${change > 0 ? '+' : ''}${change.toFixed(2)}%)`);
      
      // 检查价格偏差
      this.checkPriceDeviation();
    }
    
    // 🔑 检查止盈条件 - 有持仓时更频繁检查
    const positionValue = this.solBalance * this.currentPrice;
    if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold) {
      // 有持仓时：任何价格变化都检查止盈（止盈目标只有0.25%，需要敏感监控）
      if (oldPrice > 0 && Math.abs(this.currentPrice - oldPrice) > 0.01) { // 绝对变化0.01 USDC
        this.checkTakeProfit();
      }
    } else {
      // 无持仓时：只在显著价格变化时检查（减少不必要的计算）
      if (oldPrice > 0 && Math.abs(this.currentPrice - oldPrice) / oldPrice > 0.005) {
        this.checkTakeProfit();
      }
    }
  }
  
  /**
   * 🔑 订单更新处理
   */
  handleOrderUpdate(orderUpdate) {
    const { orderId, status, side, price, quantity } = orderUpdate;
    
    this.logger.log(`📡 WebSocket订单更新: ${JSON.stringify(orderUpdate)}`);
    
    // 🔑 检查订单是否在活跃列表中
    if (!this.activeOrders.has(orderId)) {
      this.logger.log(`⚠️ 收到未知订单更新: ${orderId}`);
      return;
    }
    
    this.logger.log(`🔄 订单更新: ${orderId} ${status}`);
    
    if (status === 'FILLED') {
      this.logger.log(`✅ 订单成交: ${side} ${quantity} SOL @ ${price} USDC`);
      
      // 🔑 简化逻辑：买入一次记录一次
      const fillRecord = {
        orderId,
        side,
        price: parseFloat(price),
        quantity: parseFloat(quantity),
        amount: parseFloat(price) * parseFloat(quantity),
        fillTime: Date.now()
      };
      
      this.filledOrders.push(fillRecord);
      this.activeOrders.delete(orderId);
      
      if (side === 'Bid') {
        // 🔑 买单成交处理
        this.handleBuyFill(fillRecord);
        
      } else if (side === 'Ask') {
        // 🔑 卖单成交处理  
        this.handleSellFill(fillRecord);
        
        this.logger.log(`💰 止盈完成:`);
        this.logger.log(`  本轮收益: +${profit.toFixed(2)} USDC`);
        this.logger.log(`  总收益: +${this.totalProfit.toFixed(2)} USDC`);
        this.logger.log(`  完成周期: ${this.cycleCount}`);
        
        // 🔑 重置止盈状态
        this.takeProfitInProgress = false;
        
        // 重置状态并开始新周期
        setTimeout(() => this.startNewCycle(), 5000);
      }
    }
    
    if (status === 'CANCELED') {
      this.activeOrders.delete(orderId);
    }
  }
  
  /**
   * 🔑 处理WebSocket余额更新 - 减少REST API调用
   */
  handleBalanceUpdate(balances) {
    try {
      let updated = false;
      
      // 🔑 更新SOL余额 - 持仓仍用available
      if (balances.SOL) {
        const newSolBalance = parseFloat(balances.SOL.available) || 0;
        if (Math.abs(newSolBalance - this.solBalance) > 0.000001) { // 精度阈值
          this.solBalance = newSolBalance;
          updated = true;
        }
      }
      
      // 🔑 更新USDC余额 - 使用总余额 (available + locked) 保持一致性
      if (balances.USDC) {
        const usdcAvailable = parseFloat(balances.USDC.available) || 0;
        const usdcLocked = parseFloat(balances.USDC.locked) || 0;
        const newUsdcBalance = usdcAvailable + usdcLocked;  // 总余额
        if (Math.abs(newUsdcBalance - this.usdcBalance) > 0.01) { // 精度阈值
          this.usdcBalance = newUsdcBalance;
          // 更新详细余额信息
          this.usdcAvailable = usdcAvailable;
          this.usdcLocked = usdcLocked;
          updated = true;
        }
      }
      
      if (updated) {
        this.logger.log(`📡 WebSocket余额更新:`);
        this.logger.log(`  SOL: ${this.solBalance.toFixed(6)} SOL`);
        this.logger.log(`  USDC: ${this.usdcBalance.toFixed(2)} USDC (总余额=${(this.usdcAvailable||0).toFixed(2)}+${(this.usdcLocked||0).toFixed(2)})`);
        
        // 如果有SOL持仓，检查止盈条件
        const positionValue = this.solBalance * this.currentPrice;
        if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold) {
          this.checkTakeProfit();
        }
      }
    } catch (error) {
      this.logger.log(`处理余额更新失败: ${error.message}`, true);
    }
  }
  
  /**
   * 🔑 买单成交处理 - 买入一次记录一次
   */
  handleBuyFill(fillRecord) {
    const { price, quantity, amount } = fillRecord;
    
    // 更新余额
    this.solBalance += quantity;
    this.usdcBalance -= amount;
    
    this.logger.log(`📊 买单成交后状态:`);
    this.logger.log(`  SOL持仓: ${this.solBalance.toFixed(6)} SOL`);
    this.logger.log(`  剩余资金: ${this.usdcBalance.toFixed(2)} USDC`);
    
    // 立即检查止盈
    this.logger.log(`🔍 买单成交，立即检查止盈...`);
    setTimeout(() => {
      this.checkTakeProfit();
    }, 500);
  }
  
  /**
   * 🔑 卖单成交处理 - 止盈完成，开始下一轮
   */
  handleSellFill(fillRecord) {
    const { price, quantity, amount } = fillRecord;
    
    // 更新余额
    this.solBalance -= quantity;
    this.usdcBalance += amount;
    
    // 计算本轮收益
    const buyOrders = this.filledOrders.filter(order => order.side === 'Bid');
    const totalCost = buyOrders.reduce((sum, order) => sum + order.amount, 0);
    const profit = amount - totalCost;
    
    this.totalProfit += profit;
    this.cycleCount++;
    
    this.logger.log(`🎉 止盈完成:`);
    this.logger.log(`  卖出: ${quantity.toFixed(6)} SOL @ ${price.toFixed(2)} USDC`);
    this.logger.log(`  本轮成本: ${totalCost.toFixed(2)} USDC`);
    this.logger.log(`  本轮收益: +${profit.toFixed(2)} USDC`);
    this.logger.log(`  总收益: +${this.totalProfit.toFixed(2)} USDC`);
    
    // 清空记录，开始下一轮
    this.logger.log(`🔄 准备开始新一轮...`);
    setTimeout(() => {
      this.startNewCycle();
    }, 2000);
  }

  /**
   * 🔑 更新持仓数据 - 基于实际成交记录
   */
  updatePositionData() {
    const buyOrders = this.filledOrders.filter(order => order.side === 'Bid');
    
    if (buyOrders.length === 0) {
      // 没有成交记录时保持原有数据
      return;
    }
    
    // 基于实际成交记录更新持仓数据
    let totalCost = 0;
    let totalQuantity = 0;
    
    for (const order of buyOrders) {
      totalCost += order.amount;
      totalQuantity += order.quantity;
    }
    
    // 更新持仓基础数据
    this.positionCost = totalCost;
    this.positionQuantity = totalQuantity;
    this.positionAvgPrice = totalCost / totalQuantity;
    
    this.logger.log(`🔄 持仓数据已更新:`);
    this.logger.log(`  成交记录: ${buyOrders.length} 笔`);
    this.logger.log(`  总成本: ${this.positionCost.toFixed(2)} USDC`);  
    this.logger.log(`  总数量: ${this.positionQuantity.toFixed(6)} SOL`);
    this.logger.log(`  平均价格: ${this.positionAvgPrice.toFixed(2)} USDC`);
  }

  /**
   * 🔑 计算平均成本
   */
  calculateAverageCost() {
    if (this.solBalance <= 0) return null;
    
    // 🔑 简化逻辑：基于当前周期的成交记录
    const buyOrders = this.filledOrders.filter(order => order.side === 'Bid');
    
    if (buyOrders.length === 0) {
      // 启动时有持仓但无成交记录 - 使用当前价格作为基准
      const averageCost = this.currentPrice;
      const profitPercent = 0; // 刚启动时收益为0
      
      this.logger.log(`📈 持仓分析 (启动状态):`);
      this.logger.log(`  实际持仓: ${this.solBalance.toFixed(6)} SOL`);
      this.logger.log(`  基准价格: ${averageCost.toFixed(2)} USDC`);
      this.logger.log(`  当前价格: ${this.currentPrice} USDC`);
      this.logger.log(`  收益率: ${profitPercent.toFixed(3)}% (目标: ${this.takeProfitPercent}%)`);
      
      return { averageCost, profitPercent };
    }
    
    // 🔑 基于本周期实际成交计算
    let totalCost = 0;
    let totalQuantity = 0;
    
    for (const order of buyOrders) {
      totalCost += order.amount;
      totalQuantity += order.quantity;
    }
    
    const averageCost = totalCost / totalQuantity;
    const profitPercent = ((this.currentPrice - averageCost) / averageCost) * 100;
    
    this.logger.log(`📈 持仓分析 (本周期):`);
    this.logger.log(`  成交记录: ${buyOrders.length} 笔买单`);
    this.logger.log(`  实际持仓: ${this.solBalance.toFixed(6)} SOL`);
    this.logger.log(`  总投入: ${totalCost.toFixed(2)} USDC`);
    this.logger.log(`  成交数量: ${totalQuantity.toFixed(6)} SOL`);
    this.logger.log(`  平均成本: ${averageCost.toFixed(2)} USDC`);
    this.logger.log(`  当前价格: ${this.currentPrice} USDC`);
    this.logger.log(`  收益率: ${profitPercent.toFixed(3)}% (目标: ${this.takeProfitPercent}%)`);
    this.logger.log(`  是否达到: ${profitPercent >= this.takeProfitPercent ? '✅ 是' : '❌ 否'}`);
    
    return { averageCost, profitPercent };
  }
  
  /**
   * 🔑 检查止盈条件
   */
  checkTakeProfit() {
    if (this.solBalance <= 0.01) return; // 没有持仓
    if (this.takeProfitInProgress) return; // 止盈正在进行中
    
    const analysis = this.calculateAverageCost();
    if (!analysis) return;
    
    if (analysis.profitPercent >= this.takeProfitPercent) {
      // 防止短时间内重复触发
      const now = Date.now();
      if (now - this.lastTakeProfitTime < 30000) { // 30秒内不重复
        return;
      }
      
      this.logger.log(`\n🚀 === 触发止盈条件 ===`);
      this.logger.log(`收益率: ${analysis.profitPercent.toFixed(3)}% >= ${this.takeProfitPercent}%`);
      
      this.lastTakeProfitTime = now;
      this.executeTakeProfit();
    }
  }
  
  /**
   * 🔑 执行止盈
   */
  async executeTakeProfit() {
    if (this.takeProfitInProgress) {
      this.logger.log('⚠️ 止盈已在进行中，跳过重复执行');
      return;
    }
    
    try {
      this.takeProfitInProgress = true;
      
      // 🔑 停止订单监控 - 不再需要等待3分钟超时
      this.monitoring = false;
      this.logger.log('⏹️ 止盈启动，停止订单监控');
      
      // 🔑 刷新余额确保数据准确
      await this.refreshBalances();
      
      // 检查实际可用SOL余额
      if (this.solBalance < 0.01) {
        this.logger.log('❌ 无可用SOL进行止盈 - 余额太少，开始新周期');
        this.takeProfitInProgress = false;
        // 🔑 重要：SOL余额太少时，启动新周期
        setTimeout(() => {
          this.logger.log('🔄 SOL已清仓，5秒后启动新马丁周期...');
          this.startNewCycle();
        }, 5000);
        return;
      }
      
      // 🔑 检查余额是否足够进行止盈（至少需要0.02 SOL才能安全操作）
      if (this.solBalance < 0.02) {
        this.logger.log(`⚠️ SOL余额过低 (${this.solBalance.toFixed(6)} SOL)，无法安全止盈 - 开始新周期`);
        this.takeProfitInProgress = false;
        // 🔑 重要：SOL余额过低时，也启动新周期
        setTimeout(() => {
          this.logger.log('🔄 SOL余额过低，5秒后启动新马丁周期...');
          this.startNewCycle();
        }, 5000);
        return;
      }
      
      // 🔑 取消所有剩余的买单 - 已经可以止盈了不需要继续买入
      if (this.activeOrders.size > 0) {
        this.logger.log(`🛑 取消剩余的${this.activeOrders.size}个买单...`);
        try {
          await this.safeApiCall(
            () => this.service.cancelAllOrders(),
            '取消剩余买单'
          );
          this.activeOrders.clear();
        } catch (error) {
          this.logger.log(`取消剩余订单失败: ${error.message}`, true);
        }
      }
      
      const sellPrice = this.formatPrice(this.currentPrice * 0.9995); // 0.05%折扣确保成交
      // 🔑 修复：考虑手续费和余额精度，使用更保守的安全边距
      const tradingFeeReserve = 0.002; // 0.2% 交易手续费预留
      const precisionReserve = 0.008; // 0.8% 余额精度预留 (增加以避免格式化问题)
      const totalSafetyMargin = 1 - tradingFeeReserve - precisionReserve; // 99.0% 可用
      const safeSOLAmount = this.solBalance * totalSafetyMargin;
      // 🔑 关键修复：直接使用可用余额作为限制
      let sellQuantity = this.formatQuantity(safeSOLAmount, this.solBalance);
      
      this.logger.log(`🔧 格式化后数量检查: ${sellQuantity} SOL (余额: ${this.solBalance} SOL)`);
      const symbol = `${this.config.trading.tradingCoin}_USDC`;
      
      this.logger.log(`🔨 创建止盈卖单:`);
      this.logger.log(`  实际SOL余额: ${this.solBalance.toFixed(6)} SOL`);
      this.logger.log(`  手续费预留: ${(tradingFeeReserve * 100).toFixed(1)}%`);
      this.logger.log(`  精度预留: ${(precisionReserve * 100).toFixed(1)}%`);
      this.logger.log(`  安全边距: ${(totalSafetyMargin * 100).toFixed(1)}%`);
      this.logger.log(`  安全数量: ${this.solBalance.toFixed(6)} × ${totalSafetyMargin.toFixed(3)} = ${safeSOLAmount.toFixed(6)} SOL`);
      this.logger.log(`  最终卖出: ${sellQuantity} SOL @ ${sellPrice} USDC`);
      this.logger.log(`  预计收入: ${(parseFloat(sellQuantity) * parseFloat(sellPrice)).toFixed(2)} USDC`);
      
      const sellResult = await this.safeApiCall(
        () => this.service.createSellOrder(sellPrice, sellQuantity, symbol),
        `止盈卖出`
      );
      
      if (sellResult && sellResult.orderId) {
        this.activeOrders.set(sellResult.orderId, {
          orderId: sellResult.orderId,
          side: 'Ask',
          price: sellPrice,
          quantity: sellQuantity,
          createTime: Date.now()
        });
        this.logger.log(`✅ 止盈订单创建成功: ${sellResult.orderId}`);
      } else {
        this.logger.log('❌ 止盈订单创建失败: 响应为空');
        this.takeProfitInProgress = false; // 失败时重置状态
      }
      
    } catch (error) {
      this.logger.log(`止盈失败: ${error.message}`, true);
      this.takeProfitInProgress = false; // 失败时重置状态
    }
  }
  
  /**
   * 🔑 检查价格偏差
   */
  checkPriceDeviation() {
    if (!this.strategyStartPrice || this.activeOrders.size === 0) return;
    
    const priceChangePercent = Math.abs(
      (this.currentPrice - this.strategyStartPrice) / this.strategyStartPrice * 100
    );
    
    if (priceChangePercent > this.maxPriceDifference) {
      this.logger.log(`🔄 价格偏差过大: ${priceChangePercent.toFixed(2)}% > ${this.maxPriceDifference}%`);
      this.logger.log(`重新挂单...`);
      
      setTimeout(() => this.restartOrders(), 1000);
    }
  }
  
  /**
   * 🔑 重新挂单 - 使用批量取消减少API调用
   */
  async restartOrders() {
    if (this.activeOrders.size === 0) {
      await this.createMartingaleOrders();
      return;
    }
    
    this.logger.log(`🔄 批量取消${this.activeOrders.size}个订单并重新挂单...`);
    
    try {
      // 🔑 使用批量取消 - 一次API调用取消所有订单
      const symbol = `${this.config.trading.tradingCoin}_USDC`;
      await this.safeApiCall(
        () => this.service.cancelAllOrders(symbol),
        `批量取消所有订单`
      );
      
      this.logger.log(`✅ 批量取消完成`);
      this.activeOrders.clear();
      
    } catch (error) {
      this.logger.log(`批量取消失败，尝试逐个取消: ${error.message}`, true);
      
      // 🔑 批量取消失败时，逐个取消但加大间隔
      const orderIds = Array.from(this.activeOrders.keys());
      let cancelCount = 0;
      
      for (let i = 0; i < orderIds.length; i++) {
        const orderId = orderIds[i];
        
        try {
          // 🔑 逐个取消时加大间隔 - 10秒
          if (i > 0) {
            this.logger.log(`⏳ 等待10秒避免API限流...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
          
          await this.service.cancelOrder(orderId);
          this.logger.log(`✅ 订单 ${orderId} 已取消`);
          cancelCount++;
          
        } catch (cancelError) {
          this.logger.log(`❌ 取消订单 ${orderId} 失败: ${cancelError.message}`, true);
          
          // 如果是400错误，可能订单已经不存在了
          if (cancelError.message.includes('400')) {
            this.logger.log(`⚠️ 订单 ${orderId} 可能已不存在，跳过`);
          }
        }
      }
      
      this.logger.log(`📊 取消结果: ${cancelCount}/${orderIds.length} 成功`);
      this.activeOrders.clear();
    }
    
    // 🔑 等待更长时间确保订单完全清理
    this.logger.log(`⏳ 等待5秒确保订单清理完成...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 🔑 取消订单后重新查询余额，获取最新的可用余额
    this.logger.log(`🔄 重新查询余额以获取释放的资金...`);
    await this.refreshBalances();
    
    // 重新创建订单 - 跳过余额检查
    await this.createMartingaleOrders(true);
  }
  
  /**
   * 🔑 创建马丁格尔订单 - 优化API调用策略
   * @param {boolean} skipBalanceCheck - 跳过余额检查（重新挂单时使用）
   */
  async createMartingaleOrders(skipBalanceCheck = false) {
    if (!this.currentPrice) {
      this.logger.log('⏳ 等待价格数据...');
      return;
    }
    
    this.logger.log(`\n🚀 === 创建马丁格尔订单 ===`);
    this.logger.log(`当前价格: ${this.currentPrice} USDC`);
    
    // 🔑 检查是否有现有持仓，调整策略
    let basePrice = this.currentPrice;
    let positionValue = this.solBalance * this.currentPrice;
    let hasExistingPosition = this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold;
    
    // 记录持仓检查结果
    if (this.solBalance > 0.01) {
      this.logger.log(`📊 持仓检查: ${this.solBalance.toFixed(6)} SOL, 价值 $${positionValue.toFixed(2)}`);
      if (positionValue < this.minPositionValueThreshold) {
        this.logger.log(`⚡ 持仓价值低于 $${this.minPositionValueThreshold} 阈值，视为无持仓，开启新一轮`);
      }
    }
    
    if (hasExistingPosition && this.filledOrders.length > 0) {
      // 有持仓时，基于持仓平均成本调整订单策略
      const analysis = this.calculateAverageCost();
      if (analysis && analysis.averageCost) {
        basePrice = Math.min(this.currentPrice, analysis.averageCost); // 使用较低价格作为基准
        this.logger.log(`📊 持仓均价: ${analysis.averageCost.toFixed(2)} USDC`);
        this.logger.log(`📊 调整基准: ${basePrice.toFixed(2)} USDC (继续摊低成本)`);
      }
    } else {
      this.logger.log(`📊 基准价格: ${basePrice} USDC (新建仓位)`);
    }
    
    // 记录策略启动价格
    this.strategyStartPrice = basePrice;
    
    // 🔑 计算订单价格分布 - 基于调整后的基准价格
    const firstOrderDrop = hasExistingPosition ? 0.5 : 0.2; // 有持仓时下跌更多才挂单
    const firstOrderPrice = this.formatPrice(basePrice * (1 - firstOrderDrop/100));
    const lowestPrice = this.formatPrice(basePrice * (1 - this.maxDropPercent/100));
    
    // 🔑 基于USDC总余额计算订单分布，最大化资金利用率
    const r = 1 + this.incrementPercent / 100;
    const availableFunds = this.usdcBalance;  // 只用USDC总余额（含锁定资金）
    
    this.logger.log(`📊 订单金额计算:`);
    this.logger.log(`  USDC余额: ${this.usdcBalance.toFixed(2)} USDC (总余额=${(this.usdcAvailable||0).toFixed(2)}+${(this.usdcLocked||0).toFixed(2)})`);
    this.logger.log(`  SOL持仓: ${this.solBalance.toFixed(6)} SOL × ${this.currentPrice} = ${(this.solBalance * this.currentPrice).toFixed(2)} USDC`);
    this.logger.log(`  计算基础: ${availableFunds.toFixed(2)} USDC (仅基于USDC总余额，含锁定资金)`);
    
    if (hasExistingPosition) {
      this.logger.log(`📊 有持仓模式 - 用固定金额确保订单分布一致`);
    } else {
      this.logger.log(`📊 新建仓位模式 - 用固定金额创建标准订单`);
    }
    
    const baseAmount = availableFunds * (r - 1) / (Math.pow(r, this.orderCount) - 1);
    
    const orders = [];
    
    // 计算每个订单
    for (let i = 0; i < this.orderCount; i++) {
      let orderPrice;
      
      if (i === 0) {
        orderPrice = firstOrderPrice;
      } else {
        const remainingRange = firstOrderPrice - lowestPrice;
        const stepPrice = firstOrderPrice - (remainingRange * i / (this.orderCount - 1));
        orderPrice = this.formatPrice(stepPrice);
      }
      
      const orderAmount = baseAmount * Math.pow(r, i);
      const orderQuantity = this.formatQuantity(orderAmount / orderPrice);
      
      orders.push({
        price: orderPrice,
        quantity: orderQuantity,
        amount: orderPrice * orderQuantity
      });
    }
    
    // 显示订单计划
    this.logger.log(`📋 马丁订单计划:`);
    let totalPlanned = 0;
    orders.forEach((order, i) => {
      const dropPercent = ((order.price - basePrice) / basePrice * 100);
      const currentDropPercent = ((order.price - this.currentPrice) / this.currentPrice * 100);
      this.logger.log(`  订单${i + 1}: ${order.quantity} SOL @ ${order.price} USDC (基准${dropPercent.toFixed(2)}% | 当前${currentDropPercent.toFixed(2)}%) = ${order.amount.toFixed(2)} USDC`);
      totalPlanned += order.amount;
    });
    this.logger.log(`计划投资: ${totalPlanned.toFixed(2)} USDC`);
    
    // 🔑 修复：允许部分订单创建，不因总金额不足而完全跳过
    if (!skipBalanceCheck) {
      // 刷新余额获取准确数据
      await this.refreshBalances();
      
      this.logger.log(`💰 资金检查:`);
      this.logger.log(`  计划投资: ${totalPlanned.toFixed(2)} USDC`);
      this.logger.log(`  总余额: ${this.usdcBalance.toFixed(2)} USDC (可用${(this.usdcAvailable||0).toFixed(2)}+锁定${(this.usdcLocked||0).toFixed(2)})`);
      
      // 🔑 修正：资金检查基于总余额，因为旧挂单会被取消释放资金
      if (this.usdcBalance < totalPlanned * 0.3) { // 至少需要30%资金才创建订单
        this.logger.log(`❌ 总资金太少，无法创建任何订单`);
        return;
      } else if (this.usdcBalance < totalPlanned) {
        this.logger.log(`⚠️ 资金不足以创建所有订单，将创建资金允许的订单`);
      } else {
        this.logger.log(`✅ 总资金充足，可创建所有订单（含释放的锁定资金）`);
      }
    } else {
      this.logger.log(`🔄 重新挂单模式 - 跳过余额检查，直接创建订单`);
      // 仍然需要刷新余额以获取准确数据
      await this.refreshBalances();
    }
    
    const symbol = `${this.config.trading.tradingCoin}_USDC`;
    const successOrders = [];
    
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      
      try {
        // 🔑 订单创建前的余额验证 - 手续费用SOL支付，USDC不需要预留
        const orderCost = order.price * order.quantity;
        if (this.usdcBalance < orderCost) {
          this.logger.log(`⚠️ 订单${i + 1}跳过: 余额不足 (需要${orderCost.toFixed(2)}, 可用${this.usdcBalance.toFixed(2)})`);
          continue;
        }
        
        // 严格格式化参数
        const formattedPrice = this.formatPrice(order.price);
        const formattedQuantity = this.formatQuantity(order.quantity);
        
        this.logger.log(`\n🔨 创建订单${i + 1}: ${formattedQuantity} SOL @ ${formattedPrice} USDC`);
        this.logger.log(`  订单成本: ${(formattedPrice * formattedQuantity).toFixed(2)} USDC`);
        this.logger.log(`  剩余余额: ${this.usdcBalance.toFixed(2)} USDC`);
        
        const buyResult = await this.safeApiCall(
          () => this.service.createBuyOrder(formattedPrice, formattedQuantity, symbol),
          `订单${i + 1}`
        );
        
        // 🔑 成功后立即扣减余额记录，避免重复扣减
        if (buyResult) {
          this.usdcBalance -= formattedPrice * formattedQuantity;
        }
        
        // 🔍 调试API响应
        this.logger.log(`🔍 订单${i + 1}响应调试:`);
        this.logger.log(`  响应类型: ${typeof buyResult}`);
        this.logger.log(`  响应内容: ${JSON.stringify(buyResult)}`);
        
        if (buyResult && buyResult.orderId) {
          this.activeOrders.set(buyResult.orderId, {
            orderId: buyResult.orderId,
            side: 'Bid',
            price: order.price,
            quantity: order.quantity,
            createTime: Date.now()
          });
          successOrders.push(buyResult.orderId);
          this.logger.log(`✅ 订单${i + 1}成功: ${buyResult.orderId}`);
        } else if (buyResult) {
          // 检查是否有其他字段标识订单ID
          const possibleIds = ['id', 'orderID', 'order_id', 'clientOrderId', 'clientOrderID'];
          let foundId = null;
          
          for (const field of possibleIds) {
            if (buyResult[field]) {
              foundId = buyResult[field];
              this.logger.log(`🔍 找到订单ID字段: ${field} = ${foundId}`);
              break;
            }
          }
          
          if (foundId) {
            this.activeOrders.set(foundId, {
              orderId: foundId,
              side: 'Bid',
              price: order.price,
              quantity: order.quantity,
              createTime: Date.now()
            });
            successOrders.push(foundId);
            this.logger.log(`✅ 订单${i + 1}成功: ${foundId}`);
          } else {
            this.logger.log(`❌ 订单${i + 1}失败: 响应中未找到订单ID`);
          }
        } else {
          this.logger.log(`❌ 订单${i + 1}失败: 响应为空或null`);
        }
        
      } catch (error) {
        this.logger.log(`❌ 订单${i + 1}失败: ${error.message}`, true);
        
        if (error.message.includes('429')) {
          this.logger.log('🚫 遇到限流，停止创建剩余订单');
          break;
        }
      }
    }
    
    this.logger.log(`\n📊 订单创建结果: ${successOrders.length}/${orders.length} 成功`);
    
    if (successOrders.length > 0) {
      this.logger.log('🎯 马丁策略启动成功！');
      this.startOrderMonitoring();
    } else {
      this.logger.log('⚠️ 所有订单创建失败，将在30秒后重试...');
      setTimeout(() => {
        this.logger.log('🔄 重试创建马丁订单...');
        this.createMartingaleOrders();
      }, 30000);
    }
  }
  
  /**
   * 🔑 开始订单监控 - 3分钟无成交重新挂单
   */
  startOrderMonitoring() {
    if (this.monitoring) return;
    
    this.monitoring = true;
    this.logger.log(`\n🔄 === 开始订单监控 ===`);
    this.logger.log(`监控订单: ${this.activeOrders.size} 个`);
    this.logger.log(`超时设置: ${this.noFillRestartMinutes} 分钟无成交自动重新挂单`);
    this.logger.log(`检查频率: 每30秒检查一次`);
    this.logger.log(`═══════════════════════════`);
    
    const checkInterval = this.noFillRestartMinutes * 60 * 1000; // 转换为毫秒
    const shortCheckInterval = 30 * 1000; // 30秒检查一次
    
    const monitorLoop = async () => {
      if (!this.monitoring) {
        this.logger.log('📴 订单监控已停止');
        return;
      }
      
      // 如果没有活跃订单，停止监控
      if (this.activeOrders.size === 0) {
        this.logger.log('📴 无活跃订单，停止监控');
        this.monitoring = false;
        return;
      }
      
      // 检查订单是否超时
      const now = Date.now();
      let hasTimedOut = false;
      let oldestOrderAge = 0;
      
      for (const [orderId, orderInfo] of this.activeOrders.entries()) {
        const orderAge = now - orderInfo.createTime;
        if (orderAge > oldestOrderAge) {
          oldestOrderAge = orderAge;
        }
        
        if (orderAge > checkInterval) {
          this.logger.log(`⏰ 订单${orderId}超时 (${(orderAge/60000).toFixed(1)}分钟)`);
          hasTimedOut = true;
          break;
        }
      }
      
      // 每分钟显示一次监控状态
      const ageMinutes = Math.floor(oldestOrderAge / 60000);
      if (ageMinutes > 0 && (oldestOrderAge % 60000) < shortCheckInterval) {
        const remainingMinutes = Math.ceil((checkInterval - oldestOrderAge) / 60000);
        this.logger.log(`\n⏳ === 订单监控状态 ===`);
        this.logger.log(`活跃订单: ${this.activeOrders.size} 个`);
        this.logger.log(`最老订单: ${ageMinutes} 分钟`);
        this.logger.log(`重新挂单倒计时: ${remainingMinutes} 分钟`);
        this.logger.log(`监控目标: ${this.noFillRestartMinutes} 分钟无成交自动重启`);
        this.logger.log(`═══════════════════════════`);
      }
      
      if (hasTimedOut) {
        this.logger.log(`\n🚨 === 触发超时重新挂单 ===`);
        this.logger.log(`原因: 订单超过${this.noFillRestartMinutes}分钟无成交`);
        this.logger.log(`开始取消并重新创建订单...`);
        await this.restartOrders();
        // 重启订单后继续监控
        if (this.activeOrders.size > 0) {
          setTimeout(monitorLoop, shortCheckInterval);
        } else {
          this.logger.log('⚠️ 重启后无活跃订单，停止监控');
        }
      } else {
        // 继续下次检查
        setTimeout(monitorLoop, shortCheckInterval);
      }
    };
    
    // 首次检查延迟30秒
    setTimeout(monitorLoop, shortCheckInterval);
  }
  
  /**
   * 🔑 开始新周期
   */
  async startNewCycle() {
    this.logger.log(`\n🔄 === 开始新的马丁周期 (第${this.cycleCount + 1}轮) ===`);
    
    // 重置状态
    this.filledOrders = [];
    this.strategyStartPrice = 0;
    this.monitoring = false; // 🔑 重置监控状态
    
    // 🔑 重置持仓数据为新周期做准备
    this.positionCost = 0;
    this.positionAvgPrice = 0;
    this.positionQuantity = 0;
    
    // 刷新余额
    await this.refreshBalances();
    
    // 创建新的马丁订单
    await this.createMartingaleOrders();
  }
  
  /**
   * 🔑 计算周期收益
   */
  calculateCycleProfit() {
    // 简化收益计算：假设每次卖出都是盈利的
    const totalBought = this.filledOrders
      .filter(order => order.side === 'Bid')
      .reduce((sum, order) => sum + order.amount, 0);
    
    const sellPrice = this.currentPrice * 0.995;
    const totalSold = this.solBalance * sellPrice;
    
    return totalSold - totalBought;
  }
  
  /**
   * 🔑 刷新余额 - 强制API获取最新数据
   */
  async refreshBalances() {
    try {
      // 清除可能的缓存，强制API调用
      const [solPosition, usdcPosition] = await Promise.all([
        this.safeApiCall(() => this.service.getPosition('SOL'), '获取SOL余额'),
        this.safeApiCall(() => this.service.getPosition('USDC'), '获取USDC余额')
      ]);
      
      // 🔑 使用总余额 = 可用余额 + 锁定余额 (最大化资金利用率)
      // 因为开启新一轮时会取消旧挂单，locked资金会释放
      const solAvailable = parseFloat(solPosition.available || 0);
      const solLocked = parseFloat(solPosition.locked || 0);
      const usdcAvailable = parseFloat(usdcPosition.available || 0);
      const usdcLocked = parseFloat(usdcPosition.locked || 0);
      
      this.solBalance = solAvailable;  // SOL持仓仍用available
      this.usdcBalance = usdcAvailable + usdcLocked;  // USDC用总余额
      
      // 记录详细余额信息
      this.solAvailable = solAvailable;
      this.solLocked = solLocked;
      this.usdcAvailable = usdcAvailable;
      this.usdcLocked = usdcLocked;
      
      this.logger.log(`💰 实际余额更新:`);
      this.logger.log(`  SOL可用: ${solAvailable.toFixed(6)} SOL`);
      this.logger.log(`  SOL锁定: ${solLocked.toFixed(6)} SOL`);
      this.logger.log(`  USDC可用: ${usdcAvailable.toFixed(2)} USDC`);
      this.logger.log(`  USDC锁定: ${usdcLocked.toFixed(2)} USDC`);
      this.logger.log(`🎯 计算用余额:`);
      this.logger.log(`  SOL余额: ${this.solBalance.toFixed(6)} SOL (持仓用available)`);
      this.logger.log(`  USDC余额: ${this.usdcBalance.toFixed(2)} USDC (下单用总余额 ${usdcAvailable.toFixed(2)}+${usdcLocked.toFixed(2)})`);
      
      // 🔑 如果有锁定的SOL，警告用户
      if (solLocked > 0.01) {
        this.logger.log(`⚠️ 检测到 ${solLocked.toFixed(6)} SOL 被锁定（可能有挂单）`);
      }
      
      // 🔑 如果有SOL持仓但没有记录，恢复成交数据
      const positionValue = this.solBalance * this.currentPrice;
      if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold && this.filledOrders.length === 0) {
        this.logger.log(`🔍 检测到SOL持仓但无交易记录，恢复数据...`);
        await this.analyzeExistingPosition();
      }
      
    } catch (error) {
      this.logger.log(`刷新余额失败: ${error.message}`, true);
    }
  }
  
  /**
   * 🔑 分析现有持仓 - 获取实际交易历史
   */
  /**
   * 🔑 恢复现有持仓的成交记录 - 简化但准确
   */
  async analyzeExistingPosition() {
    try {
      const symbol = `${this.config.trading.tradingCoin}_USDC`;
      this.logger.log(`🔍 恢复持仓成交记录...`);
      
      // 获取最近24小时的成交历史
      const fillHistory = await this.safeApiCall(
        () => this.service.getFillHistory(symbol, 50),
        '获取成交历史'
      );
      
      if (!fillHistory || fillHistory.length === 0) {
        this.logger.log(`⚠️ 无成交历史，使用当前价格作为基准`);
        return;
      }
      
      // 🔑 简单逻辑：从最新的买单开始累加，直到匹配当前余额
      const recentBuyFills = fillHistory
        .filter(fill => {
          const side = fill.side || fill.Side;
          return side === 'Bid' || side === 'BUY';
        })
        .sort((a, b) => new Date(b.timestamp || b.createdAt) - new Date(a.timestamp || a.createdAt));
      
      let accumulatedQuantity = 0;
      let totalCost = 0;
      const targetQuantity = this.solBalance;
      
      this.logger.log(`🎯 目标匹配: ${targetQuantity.toFixed(6)} SOL`);
      
      for (const fill of recentBuyFills) {
        const fillQuantity = parseFloat(fill.quantity || fill.size);
        const fillPrice = parseFloat(fill.price);
        const fillCost = fillPrice * fillQuantity;
        
        // 如果加上这笔成交会超出余额，跳过
        if (accumulatedQuantity + fillQuantity > targetQuantity + 0.01) {
          continue;
        }
        
        // 记录成交
        this.filledOrders.push({
          orderId: fill.orderId || fill.id,
          side: 'Bid',
          price: fillPrice,
          quantity: fillQuantity,
          amount: fillCost,
          fillTime: new Date(fill.timestamp || fill.createdAt).getTime()
        });
        
        accumulatedQuantity += fillQuantity;
        totalCost += fillCost;
        
        this.logger.log(`✅ 恢复成交: ${fillQuantity.toFixed(6)} SOL @ ${fillPrice} USDC`);
        
        // 如果已经匹配到足够的数量，停止
        if (Math.abs(accumulatedQuantity - targetQuantity) <= 0.01) {
          break;
        }
      }
      
      if (this.filledOrders.length > 0) {
        // 🔑 关键：更新持仓数据！
        this.updatePositionData();
        
        this.logger.log(`📊 恢复完成:`);
        this.logger.log(`  成交记录: ${this.filledOrders.length} 笔`);
        this.logger.log(`  总投入: ${totalCost.toFixed(2)} USDC`);
        this.logger.log(`  总数量: ${accumulatedQuantity.toFixed(6)} SOL`);
        this.logger.log(`  平均成本: ${(totalCost / accumulatedQuantity).toFixed(2)} USDC`);
        
        // 🔑 立即开始监控止盈
        this.logger.log(`🎯 开始监控止盈条件...`);
        
      } else {
        this.logger.log(`⚠️ 无法匹配成交记录，使用当前价格作为基准`);
        // 即使无记录，也要设置基础持仓数据
        this.positionCost = this.solBalance * this.currentPrice;
        this.positionAvgPrice = this.currentPrice;
        this.positionQuantity = this.solBalance;
      }
      
    } catch (error) {
      this.logger.log(`恢复持仓记录失败: ${error.message}`, true);
    }
  }

  
  /**
   * 🔑 启动马丁交易器
   */
  async start() {
    try {
      const symbol = await this.initialize();
      
      // 启动WebSocket
      this.wsManager.setupPriceWebSocket(symbol);
      
      // 🔑 订阅订单更新 - 实时监控订单成交
      this.wsManager.subscribeOrderUpdates();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (!this.wsManager.isConnected()) {
        throw new Error('WebSocket连接失败');
      }
      
      // 等待价格数据
      let attempts = 0;
      while (!this.currentPrice && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
      
      if (!this.currentPrice) {
        throw new Error('无法获取价格数据');
      }
      
      this.logger.log(`📊 WebSocket连接成功，当前价格: ${this.currentPrice} USDC`);
      
      // 刷新余额
      await this.refreshBalances();
      
      // 开始运行
      this.isRunning = true;
      
      // 检查是否有现有持仓
      const minPositionValue = 20;
      const minSolQuantity = minPositionValue / this.currentPrice;
      
      if (this.solBalance > minSolQuantity) {
        this.logger.log(`🎯 检测到现有持仓，分析策略选择...`);
        
        // 分析现有持仓情况
        await this.analyzeExistingPosition();
        
        // 检查是否达到止盈条件
        const analysis = this.calculateAverageCost();
        if (analysis && analysis.profitPercent >= this.takeProfitPercent) {
          this.logger.log(`\n🚀 === 立即执行止盈 ===`);
          this.logger.log(`当前收益: ${analysis.profitPercent.toFixed(3)}% >= ${this.takeProfitPercent}%`);
          
          if (!this.takeProfitInProgress) {
            setTimeout(() => {
              this.executeTakeProfit();
            }, 2000);
          }
        } else {
          // 🔑 马丁策略核心：未达到止盈时继续挂更低价买单
          this.logger.log(`\n📉 === 继续马丁策略 ===`);
          if (analysis) {
            this.logger.log(`当前收益: ${analysis.profitPercent.toFixed(3)}% < ${this.takeProfitPercent}%`);
          }
          this.logger.log(`价格下跌时加仓摊低成本，等待反弹止盈`);
          
          // 创建马丁订单继续加仓
          await this.createMartingaleOrders();
        }
      } else {
        // 无持仓，正常创建马丁订单
        this.logger.log(`📦 无持仓，创建初始马丁订单...`);
        await this.createMartingaleOrders();
      }
      
      this.logger.log('\n🎯 === 马丁策略交易器启动完成 ===');
      this.logger.log('系统将自动运行完整的马丁策略循环');
      
      // 状态报告 - 减少频率避免日志刷屏
      setInterval(() => {
        this.printStatus();
      }, 1800000); // 每30分钟
      
      // 🔑 定期检查余额和订单状态 - 降低频率，主要依赖WebSocket
      setInterval(async () => {
        try {
          // 只在必要时刷新余额（降低REST API调用）
          const positionValue = this.solBalance * this.currentPrice;
          if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold) {
            this.logger.log(`💰 定期检查: SOL余额 ${this.solBalance.toFixed(6)} (缓存)`);
            this.checkTakeProfit();
          } else {
            // 无持仓时每5分钟完整刷新一次余额
            await this.refreshBalances();
          }
        } catch (error) {
          this.logger.log(`定期检查失败: ${error.message}`, true);
        }
      }, 300000); // 每5分钟检查一次
      
      // 🔑 高频止盈检查 - 确保不错过止盈机会
      setInterval(() => {
        const positionValue = this.solBalance * this.currentPrice;
        if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold && this.currentPrice > 0) {
          // 有持仓时每30秒检查一次止盈（无需API调用，纯计算）
          this.checkTakeProfit();
        }
      }, 30000); // 每30秒检查一次
      
    } catch (error) {
      this.logger.log(`启动失败: ${error.message}`, true);
      throw error;
    }
  }
  
  printStatus() {
    const priceAge = this.lastPriceUpdate ? (Date.now() - this.lastPriceUpdate) / 1000 : 0;
    
    this.logger.log(`\n📊 === 马丁策略详细状态 ===`);
    this.logger.log(`⏰ 时间: ${new Date().toLocaleString()}`);
    this.logger.log(`💰 当前价格: ${this.currentPrice} USDC (${priceAge.toFixed(0)}秒前)`);
    this.logger.log(`📦 持仓情况:`);
    this.logger.log(`  SOL持仓: ${this.solBalance.toFixed(6)} SOL`);
    this.logger.log(`  USDC余额: ${this.usdcBalance.toFixed(2)} USDC (总余额=${(this.usdcAvailable||0).toFixed(2)}+${(this.usdcLocked||0).toFixed(2)})`);
    
    // 🔑 计算并显示详细的盈亏情况
    const positionValue = this.solBalance * this.currentPrice;
    if (this.solBalance > 0.01 && positionValue >= this.minPositionValueThreshold && this.filledOrders.length > 0) {
      const analysis = this.calculateAverageCost();
      if (analysis) {
        const currentValue = this.solBalance * this.currentPrice;
        const totalCost = this.filledOrders
          .filter(order => order.side === 'Bid')
          .reduce((sum, order) => sum + order.amount, 0);
        const unrealizedProfit = currentValue - totalCost;
        
        this.logger.log(`📈 持仓分析:`);
        this.logger.log(`  平均成本: ${analysis.averageCost.toFixed(2)} USDC`);
        this.logger.log(`  持仓价值: ${currentValue.toFixed(2)} USDC`);
        this.logger.log(`  浮动盈亏: ${unrealizedProfit > 0 ? '+' : ''}${unrealizedProfit.toFixed(2)} USDC (${analysis.profitPercent > 0 ? '+' : ''}${analysis.profitPercent.toFixed(3)}%)`);
        this.logger.log(`  止盈目标: ${this.takeProfitPercent}% ${analysis.profitPercent >= this.takeProfitPercent ? '✅已达到' : '⏳未达到'}`);
        
        if (analysis.profitPercent < this.takeProfitPercent) {
          const needGain = this.takeProfitPercent - analysis.profitPercent;
          const targetPrice = analysis.averageCost * (1 + this.takeProfitPercent / 100);
          this.logger.log(`  还需上涨: ${needGain.toFixed(3)}% (目标价格: ${targetPrice.toFixed(2)} USDC)`);
        }
      }
    } else {
      this.logger.log(`📈 持仓分析: 无持仓`);
    }
    
    this.logger.log(`🔄 订单状态:`);
    this.logger.log(`  活跃订单: ${this.activeOrders.size} 个`);
    this.logger.log(`  已成交: ${this.filledOrders.length} 个`);
    
    this.logger.log(`📊 策略统计:`);
    this.logger.log(`  完成周期: ${this.cycleCount} 轮`);
    this.logger.log(`  总收益: ${this.totalProfit > 0 ? '+' : ''}${this.totalProfit.toFixed(2)} USDC`);
    
    this.logger.log(`🌐 连接状态: ${this.wsManager.isConnected() ? '✅ WebSocket已连接' : '❌ WebSocket断开'}`);
    this.logger.log(`═══════════════════════════════════════`);
  }
  
  async shutdown() {
    this.logger.log('🛑 正在关闭马丁策略交易器...');
    
    this.isRunning = false;
    this.monitoring = false;
    
    // 🔑 批量取消所有活跃订单
    if (this.activeOrders.size > 0) {
      this.logger.log(`🗂️ 批量取消 ${this.activeOrders.size} 个活跃订单...`);
      
      try {
        const symbol = `${this.config.trading.tradingCoin}_USDC`;
        await Promise.race([
          this.service.cancelAllOrders(symbol),
          new Promise((_, reject) => setTimeout(() => reject(new Error('批量取消超时')), 8000))
        ]);
        this.logger.log('✅ 批量取消记录订单成功');
      } catch (error) {
        this.logger.log(`⚠️ 批量取消失败: ${error.message}`);
      }
      
      this.activeOrders.clear();
    }
    
    // 🔑 检查并取消交易所的所有实际挂单
    try {
      this.logger.log('🔍 检查交易所实际挂单...');
      const symbol = `${this.config.trading.tradingCoin}_USDC`;
      
      const openOrders = await Promise.race([
        this.service.getOpenOrders(symbol),
        new Promise((_, reject) => setTimeout(() => reject(new Error('获取挂单超时')), 8000))
      ]);
      
      if (openOrders && openOrders.length > 0) {
        this.logger.log(`🗂️ 发现 ${openOrders.length} 个交易所挂单，正在取消...`);
        
        const cancelAllPromises = openOrders.map(order => {
          const orderId = order.orderId || order.id || order.clientOrderId;
          return this.service.cancelOrder(orderId)
            .then(() => {
              this.logger.log(`✅ 交易所订单 ${orderId} 已取消`);
            })
            .catch(error => {
              this.logger.log(`❌ 取消交易所订单 ${orderId} 失败: ${error.message}`);
            });
        });
        
        await Promise.race([
          Promise.all(cancelAllPromises),
          new Promise((_, reject) => setTimeout(() => reject(new Error('取消交易所订单超时')), 15000))
        ]);
        
        this.logger.log('✅ 所有交易所挂单已处理');
      } else {
        this.logger.log('✅ 交易所无挂单');
      }
    } catch (error) {
      this.logger.log(`⚠️ 检查/取消交易所挂单失败: ${error.message}`);
    }
    
    // 关闭WebSocket连接
    if (this.wsManager) {
      this.wsManager.closeAllConnections();
    }
    
    this.logger.log('✅ 马丁策略交易器已完全关闭');
  }
}

// 启动
async function main() {
  const trader = new MartingaleTrader();
  
  // 🔑 改进的退出信号处理
  const gracefulShutdown = async (signal) => {
    console.log(`\n收到 ${signal} 信号，正在优雅关闭...`);
    
    try {
      // 设置超时强制退出，防止卡死
      const shutdownTimeout = setTimeout(() => {
        console.log('⚠️ 关闭超时，强制退出');
        process.exit(1);
      }, 15000); // 15秒超时
      
      await trader.shutdown();
      clearTimeout(shutdownTimeout);
      
      console.log('✅ 程序已正常退出');
      process.exit(0);
    } catch (error) {
      console.error('关闭过程中出错:', error.message);
      process.exit(1);
    }
  };
  
  // 监听多种退出信号
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // 终止信号
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));   // 挂起信号
  
  // 处理未捕获的异常
  process.on('uncaughtException', async (error) => {
    console.error('未捕获的异常:', error);
    await gracefulShutdown('uncaughtException');
  });
  
  process.on('unhandledRejection', async (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    await gracefulShutdown('unhandledRejection');
  });
  
  try {
    await trader.start();
    process.stdin.resume();
  } catch (error) {
    console.error('马丁策略启动失败:', error.message);
    process.exit(1);
  }
}

main();