# Failure handling

worker 失败时先记录证据并判断重试、换 worker、调整阶段或升级；不得吞掉失败。资源不足时进入明确等待条件；结果不满足交付要求时安排整改。编排 runtime 的意外由 Harness 收拢和恢复，不能靠模型自称健康。
