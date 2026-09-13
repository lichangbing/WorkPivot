# v0.3.0-preview.7 本机 WSL 体验版

双击“启动本地版.cmd”启动本地后台和客户端。安装包：installers/WorkPivot-Setup-0.3.0-preview.7.exe；也可直接使用随附便携客户端。默认连接 http://127.0.0.1:39880，管理页面为 http://127.0.0.1:39880/admin。

首次使用需注册管理员并配置模型；初始化凭据见 ../deploy/artifacts/first-login-local-wsl.txt。该文件仅交付本机，不随安装包发布。已有客户端如记住了旧地址，请在“服务器→更换服务器”改为本机地址；本目录启动入口使用独立客户端配置。

后台运行在本机Ubuntu-24.04 WSL：目录/home/lichb/workpivot-local，容器workpivot-local-server；Skill主机执行服务workpivot-local-worker。使用独立持久卷workpivot-local_data、workpivot-local_workspace。后台支持自主加载Skill及隔离执行Node/Python脚本、读取模板与预装依赖，没有Docker socket挂载。Excel/PPT/Word业务Skill验收仍后排。

客户端13项检查和打包程序实际连接通过。此前完整回归467项、隔离执行16项、完整Skill服务链5项通过。此为预览版；真实模型功能需配置后验收，旧远程服务器账户、模型配置和业务文件未迁移。

WSL启动后后台容器和Skill执行服务会自动恢复；关闭WSL或Windows会停止本机服务。启动入口可重新启动服务，不代表Windows登录时自动打开客户端。
