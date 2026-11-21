# rsi-target（受控 RSI 演示靶子）

这是一个统计工具库，`src/stats.js` 当前有 4 处实现缺陷，`test/stats.test.js` 中有 4 个失败用例。

## 目标

让 `node --test` 全部通过，且**不得修改测试文件**。只能修改 `src/stats.js`（必要时可在 `src/` 下新增辅助模块）。

## 函数语义（以此为准）

- `mean(xs)`：算术平均值 = 总和 / 元素个数。
- `median(xs)`：排序后取中位数；偶数个元素时取中间两个的算术平均。排序必须**按数值大小**，不能按字符串。
- `percentile(xs, p)`：p ∈ [0, 100]，**线性插值**。排序后位置 = p/100 × (n-1)，取相邻两数的线性插值。
- `stddev(xs)`：**样本标准差**（分母 n-1，n<2 时返回 0）。
- 空数组：`mean`/`median`/`percentile` 返回 `NaN`，`stddev` 返回 0。

## 验收

```bash
node --test
```

全部用例通过即成功。不要改动 `test/`、`package.json` 或仓库外任何文件。
## 第二阶段（sprint 2）新增函数

- `mode(xs)`：众数；多个众数并列时返回**较小**的那个；空数组返回 `NaN`。
- `variance(xs)`：**样本方差**（分母 n-1，n<2 时返回 0）。
- `correlation(xs, ys)`：皮尔逊相关系数；长度不等、空数组、或任一序列标准差为 0 时返回 `NaN`。
