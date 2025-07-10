const { log } = require('../utils/logger');

/**
 * 对账服务类 - 负责启动时账户余额与本地统计的自动对账
 * 实现方案一：启动时自动对账，余额为主，强制同步
 */
class ReconciliationService {
  /**
   * 构造函数
   * @param {Object} backpackService - Backpack API服务实例
   * @param {Object} tradeStats - 交易统计实例
   * @param {Object} config - 配置对象
   * @param {Object} logger - 日志记录器
   */
  constructor(backpackService, tradeStats, config, logger) {
    this.backpackService = backpackService;
    this.tradeStats = tradeStats;
    this.config = config;
    this.logger = logger || console;
    this.tradingCoin = config.trading?.tradingCoin || 'BTC';
  }

  /**
   * 执行启动时自动对账
   * 核心思路：以交易所真实余额为准，强制同步本地统计
   * @returns {Promise<Object>} 对账结果
   */
  async reconcilePosition() {
    try {
      log('\n===== 启动自动对账系统 =====');
      log('正在执行账户余额与本地统计的对账...');
      
      // 1. 获取交易所真实余额
      const realBalance = await this.getRealBalance();
      if (realBalance === null) {
        log('❌ 无法获取真实余额，对账失败', true);
        return { success: false, error: '获取余额失败' };
      }

      // 2. 获取本地统计的累计买入量
      const localAmount = this.tradeStats.totalFilledQuantity || 0;
      
      // 3. 计算差异
      const difference = Math.abs(realBalance - localAmount);
      const tolerance = this.calculateTolerance(); // 允许的误差范围
      
      log(`🔍 对账检查结果:`);
      log(`   交易所真实余额: ${realBalance.toFixed(6)} ${this.tradingCoin}`);
      log(`   本地统计数量: ${localAmount.toFixed(6)} ${this.tradingCoin}`);
      log(`   差异: ${difference.toFixed(6)} ${this.tradingCoin}`);
      log(`   允许误差: ${tolerance.toFixed(6)} ${this.tradingCoin}`);

      // 4. 判断是否需要同步
      if (difference <= tolerance) {
        log('✅ 账户余额与本地统计一致，无需对账');
        return { 
          success: true, 
          needSync: false, 
          realBalance, 
          localAmount, 
          difference 
        };
      }

      // 5. 执行强制同步
      log('⚠️  检测到账户余额与本地统计不符，开始强制同步...');
      const syncResult = await this.forceSyncWithBalance(realBalance, localAmount);
      
      if (syncResult.success) {
        log('✅ 账户对账完成，数据已强制同步');
        return {
          success: true,
          needSync: true,
          realBalance,
          localAmount: localAmount,
          newLocalAmount: realBalance,
          difference,
          syncResult
        };
      } else {
        log('❌ 账户对账失败', true);
        return { success: false, error: syncResult.error };
      }

    } catch (error) {
      log(`❌ 对账过程发生错误: ${error.message}`, true);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取交易所真实余额
   * @returns {Promise<number|null>} 真实余额数量
   */
  async getRealBalance() {
    try {
      log(`正在查询 ${this.tradingCoin} 的真实账户余额...`);
      
      const position = await this.backpackService.getPosition(this.tradingCoin);
      
      if (!position) {
        log(`未找到 ${this.tradingCoin} 的持仓信息`, true);
        return 0; // 如果没有持仓，返回0
      }

      // 计算总余额（可用 + 冻结）
      const available = parseFloat(position.available || '0');
      const locked = parseFloat(position.locked || '0');
      const total = parseFloat(position.total || '0');
      
      // 优先使用total字段，如果没有则计算available + locked
      const realBalance = total > 0 ? total : (available + locked);
      
      log(`获取到余额信息:`);
      log(`   可用余额: ${available.toFixed(6)} ${this.tradingCoin}`);
      log(`   冻结余额: ${locked.toFixed(6)} ${this.tradingCoin}`);
      log(`   总余额: ${realBalance.toFixed(6)} ${this.tradingCoin}`);
      
      return realBalance;
    } catch (error) {
      log(`获取真实余额失败: ${error.message}`, true);
      return null;
    }
  }

  /**
   * 强制同步本地统计与真实余额
   * @param {number} realBalance - 交易所真实余额
   * @param {number} localAmount - 本地统计数量
   * @returns {Promise<Object>} 同步结果
   */
  async forceSyncWithBalance(realBalance, localAmount) {
    try {
      const difference = realBalance - localAmount;
      
      if (realBalance > localAmount) {
        // 余额大于统计，说明有部分买单没计入
        log(`📈 余额大于统计 (+${difference.toFixed(6)} ${this.tradingCoin})`);
        log('可能原因: 部分成交记录/老订单查询不到');
        
        return await this.handlePositiveGap(difference, realBalance);
        
      } else if (realBalance < localAmount) {
        // 余额小于统计，可能有人工卖出或提币
        log(`📉 余额小于统计 (-${Math.abs(difference).toFixed(6)} ${this.tradingCoin})`);
        log('可能原因: 人工卖出/提币操作未被记录');
        
        return await this.handleNegativeGap(difference, realBalance);
        
      } else {
        // 完全相等（理论上不会到这里，因为前面已经检查过）
        return { success: true, action: 'no_change', message: '余额完全一致' };
      }
      
    } catch (error) {
      log(`强制同步失败: ${error.message}`, true);
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理余额大于统计的情况（补充虚拟买单）
   * @param {number} gapAmount - 差异数量
   * @param {number} realBalance - 真实余额
   * @returns {Promise<Object>} 处理结果
   */
  async handlePositiveGap(gapAmount, realBalance) {
    try {
      log(`正在处理余额缺口，需要补充 ${gapAmount.toFixed(6)} ${this.tradingCoin} 的买入记录`);
      
      // 获取用于补充的均价
      const averagePrice = await this.getAveragePriceForGap();
      
      if (!averagePrice || averagePrice <= 0) {
        log('❌ 无法获取有效的均价用于补充买单', true);
        return { success: false, error: '无法获取均价' };
      }

      // 计算虚拟买单的金额
      const virtualAmount = gapAmount * averagePrice;
      
      log(`📝 创建虚拟买单补充记录:`);
      log(`   数量: ${gapAmount.toFixed(6)} ${this.tradingCoin}`);
      log(`   价格: ${averagePrice.toFixed(2)} USDC`);
      log(`   金额: ${virtualAmount.toFixed(2)} USDC`);

      // 直接更新统计数据
      this.tradeStats.totalFilledQuantity = realBalance;
      this.tradeStats.totalFilledAmount += virtualAmount;
      this.tradeStats.filledOrders += 1; // 增加一个虚拟订单
      
      // 重新计算均价
      if (this.tradeStats.totalFilledQuantity > 0) {
        this.tradeStats.averagePrice = this.tradeStats.totalFilledAmount / this.tradeStats.totalFilledQuantity;
      }
      
      this.tradeStats.lastUpdateTime = new Date();
      
      log(`✅ 虚拟买单补充完成`);
      log(`   新的累计数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
      log(`   新的累计金额: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
      log(`   新的平均价格: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
      
      return {
        success: true,
        action: 'virtual_buy_added',
        message: `已补充虚拟买单`,
        gapAmount,
        averagePrice,
        virtualAmount
      };
      
    } catch (error) {
      log(`处理正向差异失败: ${error.message}`, true);
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理余额小于统计的情况（强制调整为余额）
   * @param {number} gapAmount - 差异数量（负数）
   * @param {number} realBalance - 真实余额
   * @returns {Promise<Object>} 处理结果
   */
  async handleNegativeGap(gapAmount, realBalance) {
    try {
      const reductionAmount = Math.abs(gapAmount);
      log(`正在处理余额不足，需要减少 ${reductionAmount.toFixed(6)} ${this.tradingCoin} 的统计记录`);
      
      // 保存原始数据用于计算
      const originalQuantity = this.tradeStats.totalFilledQuantity;
      const originalAmount = this.tradeStats.totalFilledAmount;
      
      // 计算需要减少的金额（按比例）
      const reductionRatio = reductionAmount / originalQuantity;
      const amountReduction = originalAmount * reductionRatio;
      
      log(`📝 强制调整统计数据:`);
      log(`   减少数量: ${reductionAmount.toFixed(6)} ${this.tradingCoin}`);
      log(`   减少金额: ${amountReduction.toFixed(2)} USDC`);
      log(`   调整比例: ${(reductionRatio * 100).toFixed(2)}%`);

      // 强制同步为真实余额
      this.tradeStats.totalFilledQuantity = realBalance;
      this.tradeStats.totalFilledAmount = Math.max(0, originalAmount - amountReduction);
      
      // 重新计算均价
      if (this.tradeStats.totalFilledQuantity > 0) {
        this.tradeStats.averagePrice = this.tradeStats.totalFilledAmount / this.tradeStats.totalFilledQuantity;
      } else {
        this.tradeStats.averagePrice = 0;
      }
      
      this.tradeStats.lastUpdateTime = new Date();
      
      log(`✅ 强制调整完成`);
      log(`   新的累计数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
      log(`   新的累计金额: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
      log(`   新的平均价格: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
      
      return {
        success: true,
        action: 'forced_reduction',
        message: `已强制调整为真实余额`,
        reductionAmount,
        amountReduction
      };
      
    } catch (error) {
      log(`处理负向差异失败: ${error.message}`, true);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取用于补充缺口的均价
   * @returns {Promise<number>} 均价
   */
  async getAveragePriceForGap() {
    try {
      // 1. 如果已有统计数据，使用现有均价
      if (this.tradeStats.averagePrice > 0) {
        log(`使用现有统计均价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        return this.tradeStats.averagePrice;
      }

      // 2. 如果没有统计数据，尝试获取最新市场价格
      try {
        const ticker = await this.backpackService.getTicker(`${this.tradingCoin}_USDC`);
        if (ticker && ticker.lastPrice) {
          const marketPrice = parseFloat(ticker.lastPrice);
          log(`使用当前市场价格: ${marketPrice.toFixed(2)} USDC`);
          return marketPrice;
        }
      } catch (priceError) {
        log(`获取市场价格失败: ${priceError.message}`, true);
      }

      // 3. 如果都失败了，提示用户手动输入（在这里我们使用一个合理的默认值）
      const defaultPrice = this.getDefaultPrice();
      log(`⚠️  无法自动获取均价，使用默认价格: ${defaultPrice.toFixed(2)} USDC`);
      log(`建议: 如需精确对账，请手动设置均价`);
      
      return defaultPrice;
      
    } catch (error) {
      log(`获取均价失败: ${error.message}`, true);
      return null;
    }
  }

  /**
   * 获取默认价格（基于配置或常用价格）
   * @returns {number} 默认价格
   */
  getDefaultPrice() {
    // 优先使用配置文件中的设置
    if (this.config.reconciliation && this.config.reconciliation.defaultPrices) {
      const configPrices = this.config.reconciliation.defaultPrices;
      return configPrices[this.tradingCoin] || configPrices.DEFAULT || 50000;
    }
    
    // 备用：可以根据不同币种设置不同的默认价格
    const defaultPrices = {
      'BTC': 60000,
      'ETH': 3000,
      'SOL': 100,
      'BNB': 400
    };
    
    return defaultPrices[this.tradingCoin] || 50000; // 如果没有预设，返回一个通用默认值
  }

  /**
   * 计算允许的误差范围
   * @returns {number} 误差阈值
   */
  calculateTolerance() {
    // 优先使用配置文件中的设置
    if (this.config.reconciliation && this.config.reconciliation.tolerances) {
      const configTolerances = this.config.reconciliation.tolerances;
      return configTolerances[this.tradingCoin] || configTolerances.DEFAULT || 0.0001;
    }
    
    // 备用：根据币种设置不同的误差容忍度
    const tolerances = {
      'BTC': 0.0001,   // BTC精度要求高
      'ETH': 0.001,    // ETH次之
      'SOL': 0.01,     // SOL等可以稍微宽松
      'default': 0.0001
    };
    
    return tolerances[this.tradingCoin] || tolerances.default;
  }

  /**
   * 生成对账报告
   * @param {Object} reconcileResult - 对账结果
   * @returns {string} 格式化的对账报告
   */
  generateReconciliationReport(reconcileResult) {
    if (!reconcileResult.success) {
      return `❌ 对账失败: ${reconcileResult.error}`;
    }

    let report = '\n===== 对账报告 =====\n';
    report += `交易币种: ${this.tradingCoin}\n`;
    report += `对账时间: ${new Date().toLocaleString()}\n`;
    
    if (!reconcileResult.needSync) {
      report += '✅ 账户余额与本地统计一致，无需同步\n';
    } else {
      report += `📊 检测到差异，已执行强制同步\n`;
      report += `   原本地数量: ${reconcileResult.localAmount.toFixed(6)} ${this.tradingCoin}\n`;
      report += `   交易所余额: ${reconcileResult.realBalance.toFixed(6)} ${this.tradingCoin}\n`;
      report += `   差异: ${reconcileResult.difference.toFixed(6)} ${this.tradingCoin}\n`;
      report += `   同步动作: ${reconcileResult.syncResult.action}\n`;
      report += `   同步结果: ${reconcileResult.syncResult.message}\n`;
    }
    
    report += `当前统计状态:\n`;
    report += `   总持仓: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}\n`;
    report += `   总成本: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC\n`;
    report += `   平均价: ${this.tradeStats.averagePrice.toFixed(2)} USDC\n`;
    report += `   订单数: ${this.tradeStats.filledOrders}\n`;
    report += '====================\n';
    
    return report;
  }
}

module.exports = ReconciliationService;