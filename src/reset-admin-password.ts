import { loadLocalEnvironment } from "./environment.ts";
import { resetAdminPassword } from "./security/admin-control.ts";

loadLocalEnvironment();
try {
  const password = await resetAdminPassword();
  process.stdout.write(
    `管理员密码已重置，旧登录会话已失效。\n新密码：${password}\n`,
  );
} catch {
  process.stderr.write(
    "无法重置密码：请确认新版平台正在运行，并使用相同的数据目录及容器用户执行命令。\n",
  );
  process.exitCode = 1;
}
