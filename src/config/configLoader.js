const fs = require('fs');
const path = require('path');

/**
 * 配置加载器 - 支持单策略和双策略配置
 */
class ConfigLoader {
  /**
   * 自动检测并加载配置文件
   * @param {string} baseDir - 基础目录路径
   * @returns {Object} 配置对象和类型信息
   */
  static loadConfig(baseDir = process.cwd()) {
    // 检查双策略配置文件
    const dualConfigPath = path.join(baseDir, 'dual_strategy_config.json');
    const singleConfigPath = path.join(baseDir, 'backpack_trading_config.json');
    
    let config;
    let configType;
    let configPath;
    
    try {
      // 优先检查双策略配置
      if (fs.existsSync(dualConfigPath)) {
        const dualConfig = JSON.parse(fs.readFileSync(dualConfigPath, 'utf8'));
        
        // 检查是否启用双策略
        if (dualConfig.enableDualStrategy === true) {
          config = dualConfig;
          configType = 'dual';
          configPath = dualConfigPath;
        } else {
          // 双策略配置存在但未启用，转换为单策略
          config = this.convertDualToSingle(dualConfig);
          configType = 'single';
          configPath = dualConfigPath;
        }
      }
      // 如果没有双策略配置或未启用，使用单策略配置
      else if (fs.existsSync(singleConfigPath)) {
        config = JSON.parse(fs.readFileSync(singleConfigPath, 'utf8'));
        configType = 'single';
        configPath = singleConfigPath;
      }
      // 如果都不存在，抛出错误
      else {
        throw new Error('找不到配置文件: dual_strategy_config.json 或 backpack_trading_config.json');
      }
      
      // 验证配置
      this.validateConfig(config, configType);
      
      return {
        config,
        configType,
        configPath
      };
      
    } catch (error) {
      throw new Error(`加载配置文件失败: ${error.message}`);
    }
  }
  
  /**
   * 将双策略配置转换为单策略配置
   * @param {Object} dualConfig - 双策略配置
   * @returns {Object} 单策略配置
   */
  static convertDualToSingle(dualConfig) {
    // 使用策略1作为单策略
    const strategy1 = dualConfig.strategy1;
    
    return {
      api: dualConfig.api,
      trading: strategy1.trading,
      actions: {
        sellNonUsdcAssets: true,
        cancelAllOrders: true,
        restartAfterTakeProfit: true,
        autoRestartNoFill: true
      },
      advanced: {
        ...strategy1.advanced,
        quickRestartAfterTakeProfit: true
      },
      quantityPrecisions: {
        BTC: 5,
        ETH: 4,
        SOL: 2,
        DEFAULT: 2
      },
      pricePrecisions: {
        BTC: 0,
        ETH: 2,
        SOL: 2,
        DEFAULT: 2
      },
      minQuantities: {
        BTC: 0.00001,
        ETH: 0.001,
        SOL: 0.01,
        DEFAULT: 0.1
      },
      websocket: dualConfig.websocket
    };
  }
  
  /**
   * 验证配置文件
   * @param {Object} config - 配置对象
   * @param {string} configType - 配置类型
   */
  static validateConfig(config, configType) {
    // 验证API配置
    if (!config.api || !config.api.privateKey || !config.api.publicKey) {
      throw new Error('API配置缺失：需要privateKey和publicKey');
    }
    
    if (configType === 'dual') {
      // 验证双策略配置
      if (!config.strategy1 || !config.strategy2) {
        throw new Error('双策略配置缺失：需要strategy1和strategy2');
      }
      
      this.validateTradingConfig(config.strategy1.trading, 'strategy1');
      this.validateTradingConfig(config.strategy2.trading, 'strategy2');
      
      // 验证风险控制配置
      if (!config.riskControl) {
        throw new Error('双策略配置缺失：需要riskControl配置');
      }
    } else {
      // 验证单策略配置
      this.validateTradingConfig(config.trading, 'single');
    }
  }
  
  /**
   * 验证交易配置
   * @param {Object} trading - 交易配置
   * @param {string} strategyName - 策略名称
   */
  static validateTradingConfig(trading, strategyName) {
    if (!trading) {
      throw new Error(`${strategyName}策略缺失trading配置`);
    }
    
    const requiredFields = [
      'tradingCoin',
      'maxDropPercentage', 
      'totalAmount',
      'orderCount',
      'incrementPercentage',
      'takeProfitPercentage'
    ];
    
    for (const field of requiredFields) {
      if (trading[field] === undefined || trading[field] === null) {
        throw new Error(`${strategyName}策略缺失必需字段: ${field}`);
      }
    }
    
    // 验证数值范围
    if (trading.totalAmount <= 0) {
      throw new Error(`${strategyName}策略totalAmount必须大于0`);
    }
    
    if (trading.orderCount <= 0) {
      throw new Error(`${strategyName}策略orderCount必须大于0`);
    }
    
    if (trading.maxDropPercentage <= 0) {
      throw new Error(`${strategyName}策略maxDropPercentage必须大于0`);
    }
    
    if (trading.takeProfitPercentage <= 0) {
      throw new Error(`${strategyName}策略takeProfitPercentage必须大于0`);
    }
  }
}

module.exports = ConfigLoader; 