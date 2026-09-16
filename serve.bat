@echo off
rem WebOS 一键启动脚本:优先使用 Python,回退到 Node
where python >nul 2>nul
if %errorlevel%==0 (
  echo [WebOS] 使用 Python 启动: http://localhost:8080
  python -m http.server 8080
  goto :eof
)
where node >nul 2>nul
if %errorlevel%==0 (
  echo [WebOS] 使用 Node 启动: http://localhost:8080
  npx -y serve . -l 8080
  goto :eof
)
echo 未找到 Python 或 Node,请先安装其中之一。
pause
