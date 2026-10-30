# syntax=docker/dockerfile:1.7
# api 이미지(보강 9, decisions/0086). 시연 compose의 migrate·api·worker·demo-seed가 같은 이미지를 명령만 바꿔 쓴다.
# 빌드 컨텍스트는 저장소 루트다(packages/contracts를 file: 의존으로 읽는다): docker build -f apps/api/Dockerfile .
# 프록시 뒤에서 빌드할 때만: --build-arg HTTPS_PROXY=… 와 --secret id=ca,src=<CA 파일>(npm이 믿을 CA). 없으면 그냥 빌드한다

FROM node:24-alpine AS build
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY apps/api/package.json apps/api/package-lock.json apps/api/
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    cd apps/api && npm ci --no-audit --no-fund
COPY apps/api apps/api
RUN cd apps/api && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
# NODE_ENV=production을 두지 않는다 — 시연 계정·시연 데이터가 들어가야 한다(production이면 시드가 넣지 않는다, decisions/0054)
WORKDIR /repo/apps/api
COPY --from=build /repo/packages/contracts /repo/packages/contracts
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
# 운영 관제에 보이는 api 버전(env.appVersion, 없으면 dev — decisions/0090). 이미지에 굳혀, 그 이미지가 어느 빌드인지 컨테이너가 바뀌어도 같다.
# 맨 끝에 둔다 — 값이 바뀌어도 npm ci·빌드 층은 캐시를 그대로 쓴다
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
