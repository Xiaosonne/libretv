// 仅供 Vitest 使用：vite/vitest 的模块管道无法解析 Node 22.5+ 的内置模块
// node:sqlite（不在其内置清单中），此 shim 通过 Node 原生 require 拿到真模块。
// 生产代码（Next.js 服务端）不受影响，仍直接 import 'node:sqlite'。
module.exports = require('node:sqlite');
