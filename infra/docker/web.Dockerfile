# syntax=docker/dockerfile:1.7
# 화면 여덟(어드민·매장·현장·관제·개발자센터·시연 도구·시연 홈·소개 페이지)을 빌드해 nginx 하나로 낸다(보강 9, decisions/0086·0088).
# 호스트 이름마다 다른 앱 — 앱마다 쿠키(sid)가 따로다. 컨텍스트는 저장소 루트: docker build -f infra/docker/web.Dockerfile .
# WEB_ORIGIN은 화면끼리 건너가는 링크(어드민 "다른 화면", 현장 → 어드민)에 박힌다. 포트를 바꾸면 이 값도 같이 바꿔 빌드한다
# 프록시 뒤에서 빌드할 때만: --build-arg HTTPS_PROXY=… 와 --secret id=ca,src=<CA 파일>

FROM node:24-alpine AS build
ARG WEB_PORT=8080
WORKDIR /repo
COPY packages/contracts packages/contracts
COPY apps/admin/package.json apps/admin/package-lock.json apps/admin/
COPY apps/merchant/package.json apps/merchant/package-lock.json apps/merchant/
COPY apps/field/package.json apps/field/package-lock.json apps/field/
COPY apps/console/package.json apps/console/package-lock.json apps/console/
COPY apps/developers/package.json apps/developers/package-lock.json apps/developers/
COPY apps/sandbox/package.json apps/sandbox/package-lock.json apps/sandbox/
COPY apps/demo-home/package.json apps/demo-home/package-lock.json apps/demo-home/
COPY apps/landing/package.json apps/landing/package-lock.json apps/landing/
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    for app in admin merchant field console developers sandbox demo-home landing; do (cd apps/$app && npm ci --no-audit --no-fund) || exit 1; done
COPY apps/admin apps/admin
COPY apps/merchant apps/merchant
COPY apps/field apps/field
COPY apps/console apps/console
COPY apps/developers apps/developers
COPY apps/sandbox apps/sandbox
COPY apps/demo-home apps/demo-home
COPY apps/landing apps/landing
# 소개 페이지는 docs 폴더의 기록 수·제목을 빌드 때 읽는다(decisions/0078). 설치(npm ci) 뒤에 복사한다 — 기록은 커밋마다 늘어 앞에 두면 설치 층 캐시가 매번 깨진다(최종 검토)
COPY docs docs
# 소개 페이지의 [시연하기]는 여기서는 실제로 도는 시연 홈(demo.localhost) — GitHub Pages에서는 같은 사이트의 녹화 재생본 ./demo/(decisions/0096)
# 화면끼리 건너가는 주소(apps/admin/src/apps.ts, apps/field/src/lib/admin-link.ts — 현장은 어드민 주소 뒤에 /scans를 스스로 붙인다). 앱은 모두 같은 출처의 /api를 부른다(nginx가 넘긴다)
RUN o="http://%s.localhost:${WEB_PORT}"; \
    export VITE_MERCHANT_APP_URL=$(printf "$o" merchant) VITE_FIELD_APP_URL=$(printf "$o" field) VITE_OPS_APP_URL=$(printf "$o" console) \
      VITE_DEVELOPERS_APP_URL=$(printf "$o" developers) VITE_PARTNERS_CONSOLE_URL=$(printf "$o/partners" sandbox) VITE_SIMULATOR_APP_URL=$(printf "$o/devices" sandbox) \
      VITE_ADMIN_APP_URL=$(printf "$o" admin) VITE_SANDBOX_APP_URL=$(printf "$o" sandbox) VITE_DEMO_URL=$(printf "$o" demo); \
    for app in admin merchant field console developers sandbox demo-home landing; do (cd apps/$app && npm run build) || exit 1; done

FROM nginx:1.28-alpine
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin/dist /srv/admin
COPY --from=build /repo/apps/merchant/dist /srv/merchant
COPY --from=build /repo/apps/field/dist /srv/field
COPY --from=build /repo/apps/console/dist /srv/console
COPY --from=build /repo/apps/developers/dist /srv/developers
COPY --from=build /repo/apps/sandbox/dist /srv/sandbox
COPY --from=build /repo/apps/demo-home/dist /srv/demo-home
COPY --from=build /repo/apps/landing/dist /srv/landing
EXPOSE 8080
