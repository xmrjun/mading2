#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const MartingaleTrader = require('./martingale_trader');

/**
 * 马丁格尔策略启动脚本
 */
class MartingaleStarter {
  constructor() {
    this.configPath = process.argv[2] || 'martingale_config.json';
  }

  /**
   * 启动前检查
   */
  async preStartCheck() {
    console.log('🔍 启动前检查...\n');

    // 检查配置文件
    if (!fs.existsSync(this.configPath)) {
      console.log(`❌ 配置文件不存在: ${this.configPath}`);
      console.log('💡 请先创建配置文件或使用: node start_martingale.js [config_file]');
      process.exit(1);
    }

    // 加载和验证配置
    let config;
    try {
      config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      console.log(`✅ 配置文件加载成功: ${this.configPath}`);
    } catch (error) {
      console.log(`❌ 配置文件格式错误: ${error.message}`);
      process.exit(1);
    }

    // 检查必要参数
    const requiredParams = [
      'api.privateKey',
      'api.publicKey',
      'trading.baseAmount',
      'trading.martingaleMultiplier',
      'trading.maxConsecutiveLosses'
    ];

    const missing = [];
    for (const param of requiredParams) {
      const keys = param.split('.');
      let value = config;
      for (const key of keys) {
        value = value?.[key];
      }
      if (!value) {
        missing.push(param);
      }
    }

    if (missing.length > 0) {
      console.log('❌ 缺少必要配置参数:');
      missing.forEach(param => console.log(`   - ${param}`));
      process.exit(1);
    }

    // 检查API密钥格式
    if (config.api.privateKey === 'YOUR_PRIVATE_KEY_HERE' || 
        config.api.publicKey === 'YOUR_PUBLIC_KEY_HERE') {
      console.log('❌ 请先配置正确的API密钥');
      console.log('💡 编辑配置文件，替换默认的API密钥');
      process.exit(1);
    }

    console.log('✅ 所有配置检查通过\n');
    
    // 显示策略参数
    this.displayStrategyInfo(config);
    
    // 风险警告
    this.showRiskWarning(config);
    
    return config;
  }

  /**
   * 显示策略信息
   */
  displayStrategyInfo(config) {
    console.log('📊 策略参数:');
    console.log(`   交易币种: ${config.trading.tradingCoin || 'ETH'}`);
    console.log(`   基础金额: ${config.trading.baseAmount} USDC`);
    console.log(`   加倍系数: ${config.trading.martingaleMultiplier}x`);
    console.log(`   最大连续亏损: ${config.trading.maxConsecutiveLosses} 次`);
    console.log(`   止盈目标: ${config.trading.takeProfitPercentage || 1.0}%`);
    console.log(`   止损阈值: ${config.trading.stopLossPercentage || 10.0}%\n`);
  }

  /**
   * 显示风险警告
   */
  showRiskWarning(config) {
    const baseAmount = config.trading.baseAmount;
    const multiplier = config.trading.martingaleMultiplier;
    const maxLosses = config.trading.maxConsecutiveLosses;
    
    // 计算最大可能亏损
    const maxPossibleLoss = baseAmount * (Math.pow(multiplier, maxLosses) - 1) / (multiplier - 1);
    
    console.log('⚠️  风险警告:');
    console.log(`   最大可能亏损: ${maxPossibleLoss.toFixed(2)} USDC`);
    console.log(`   建议账户余额: ${(maxPossibleLoss * 1.5).toFixed(2)} USDC 以上`);
    console.log('   马丁格尔策略涉及高风险，请确保充分理解风险\n');
  }

  /**
   * 等待用户确认
   */
  async waitForConfirmation() {
    return new Promise((resolve) => {
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });

      readline.question('是否继续启动马丁格尔策略? (y/N): ', (answer) => {
        readline.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }

  /**
   * 启动策略
   */
  async start() {
    try {
      console.log('🎲 马丁格尔交易策略启动器\n');
      
      // 启动前检查
      const config = await this.preStartCheck();
      
      // 等待用户确认
      const confirmed = await this.waitForConfirmation();
      
      if (!confirmed) {
        console.log('❌ 用户取消启动');
        process.exit(0);
      }

      console.log('\n🚀 启动马丁格尔交易器...\n');
      
      // 创建并启动交易器
      const trader = new MartingaleTrader(this.configPath);
      
      // 处理退出信号
      process.on('SIGINT', async () => {
        console.log('\n📢 接收到停止信号...');
        await trader.gracefulShutdown();
      });
      
      process.on('SIGTERM', async () => {
        console.log('\n📢 接收到终止信号...');
        await trader.gracefulShutdown();
      });

      // 启动交易器
      await trader.start();

    } catch (error) {
      console.log(`💥 启动失败: ${error.message}`);
      process.exit(1);
    }
  }
}

// 检查是否有帮助参数
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
🎲 马丁格尔交易策略启动器

用法:
  node start_martingale.js [配置文件]

选项:
  -h, --help     显示帮助信息

示例:
  node start_martingale.js                          # 使用默认配置 martingale_config.json
  node start_martingale.js custom_config.json       # 使用自定义配置文件

配置文件示例:
  请参考 martingale_config.json 和使用指南
  
风险提示:
  马丁格尔策略涉及高风险，可能导致重大损失。
  请在充分理解风险的情况下使用。
`);
  process.exit(0);
}

// 启动应用
const starter = new MartingaleStarter();
starter.start().catch(error => {
  console.log(`💥 启动器错误: ${error.message}`);
  process.exit(1);
});