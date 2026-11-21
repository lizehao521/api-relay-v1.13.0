/**
 * 网关版本号**单一真源**。
 *
 * 背景（审查发现·缺点#7）：版本号此前散落在至少两处 —— `gateway/server.ts` 的
 * `RELAY_VERSION`（对外响应头 `x-relay-version`、`/` 与 `/healthz` 的 version 字段）
 * 与 `admin/api.ts` 的 `publicPanel().version`（公开面板镜像）。后者注释自认
 * "真源是 server.ts 的 RELAY_VERSION（能力层、未导出）……改了要同步改"——
 * 这是一处**可漂移的双真源**：升级版本只改一处，公开面板就会显示旧版本号。
 *
 * 这里把它抽成一个中立模块：server.ts 与 admin 层都引用此处，任何一处改动即时一致。
 * 只放常量、不引任何依赖，因此不会引入 server ↔ admin 的循环依赖。
 */
export const RELAY_VERSION = '1.13.0';
//# sourceMappingURL=version.js.map