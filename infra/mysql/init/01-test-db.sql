-- 볼륨을 처음 만들 때만 실행된다. 이미 만든 볼륨에는 Step 2의 명령으로 직접 적용한다.
CREATE DATABASE IF NOT EXISTS terminal_ops_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON terminal_ops_test.* TO 'terminal_ops'@'%';
FLUSH PRIVILEGES;
