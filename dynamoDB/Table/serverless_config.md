# Serverless Configuration Overview

## serverless.yml (Root)

```yaml
service: aws-uchimi
useDotenv: true
plugins:
  - serverless-api-gateway-throttling
custom:
  apiGatewayThrottling:
    maxRequestsPerSecond: 50
    maxConcurrentRequests: 20
build:
  esbuild:
    bundle: true
    minify: true
    external:
      - '@aws-sdk/*'
provider:
  name: aws
  runtime: nodejs20.x
  region: ${env:AWS_REGION}
  memorySize: 512
  environment:
    ALGOLIA_APP_ID: ${env:ALGOLIA_APP_ID}
    ALGOLIA_WRITE_KEY: ${env:ALGOLIA_WRITE_KEY}
    ALGOLIA_USER_INDEX: ${env:ALGOLIA_USER_INDEX}
    ASSETS_BUCKET: ${env:ASSETS_BUCKET}
    DEFAULT_AVATAR_URL: ${env:DEFAULT_AVATAR_URL}
    USER_TABLE: ${env:USER_TABLE}
    STUDY_TABLE: ${env:STUDY_TABLE}
    SOCIAL_TABLE: ${env:SOCIAL_TABLE}
    QUEST_TABLE: ${env:QUEST_TABLE}
    MINIGAME_TABLE: ${env:MINIGAME_TABLE}
    ITEMDATA_TABLE: ${env:ITEMDATA_TABLE}
    INVENTORY_TABLE: ${env:INVENTORY_TABLE}
    GACHAHISTORY_TABLE: ${env:GACHAHISTORY_TABLE}
    INVENTORY_TYPES: ${env:INVENTORY_TYPES}
    VERSION: ${env:VERSION}

  iam:
    role:
      statements:
        # ── DynamoDB ──────────────────────────────────────
        - Effect: Allow
          Action:
            - dynamodb:GetItem
            - dynamodb:PutItem
            - dynamodb:UpdateItem
            - dynamodb:DeleteItem
            - dynamodb:Query
            - dynamodb:Scan
            - dynamodb:BatchGetItem
            - dynamodb:BatchWriteItem
            - dynamodb:TransactWriteItems
          Resource:
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:USER_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:USER_TABLE}/index/*"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:STUDY_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:SOCIAL_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:QUEST_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:MINIGAME_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:MINIGAME_TABLE}/index/*"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:ITEMDATA_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:INVENTORY_TABLE}"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:INVENTORY_TABLE}/index/*"
            - "arn:aws:dynamodb:${self:provider.region}:*:table/${env:GACHAHISTORY_TABLE}"
        # ── DynamoDB Streams (streamIndexer Lambda) ───────
        - Effect: Allow
          Action:
            - dynamodb:DescribeStream
            - dynamodb:GetRecords
            - dynamodb:GetShardIterator
            - dynamodb:ListStreams
          Resource:
            - "${env:USER_TABLE_STREAM_ARN}"
        # ── S3 ────────────────────────────────────────────
        - Effect: Allow
          Action:
            - s3:GetObject
            - s3:PutObject
          Resource:
            - "arn:aws:s3:::${env:ASSETS_BUCKET}/public-assets/*"
            - "arn:aws:s3:::${env:ASSETS_BUCKET}/avatars/*"
            - "arn:aws:s3:::${env:ASSETS_BUCKET}/uploads/*"

  httpApi:
    cors: true
    authorizers:
      myCognitoAuth:
        type: jwt
        identitySource: $request.header.Authorization
        issuerUrl: https://cognito-idp.${self:provider.region}.amazonaws.com/${env:COGNITO_USER_POOL_ID}
        audience:
          - ${env:COGNITO_CLIENT_ID}

functions:
  - ${file(./src/uploadFunction/function.yml)}
  - ${file(./src/userFunction/function.yml)}
  - ${file(./src/sessionFunction/function.yml)}
  - ${file(./src/currencyFunction/function.yml)}
  - ${file(./src/gachaFunction/function.yml)}
  - ${file(./src/minigameFunction/function.yml)}
  - ${file(./src/questFunction/function.yml)}
  - ${file(./src/shopFunction/function.yml)}
  - ${file(./src/socialFunction/function.yml)}
  - ${file(./src/syncFunction/function.yml)}
```

---

## src/uploadFunction/function.yml

```yaml
uploadZip:
    handler: src/uploadFunction/itemUpload.processZip
    events:
      - s3:
          bucket: ${env:ASSETS_BUCKET}
          event: s3:ObjectCreated:*
          rules:
            - prefix: uploads/items/
            - suffix: .zip
          existing: true

uploadConfigJson:
    handler: src/uploadFunction/jsonUpload.processJson
    events:
      - s3:
          bucket: ${env:ASSETS_BUCKET}
          event: s3:ObjectCreated:*
          rules:
            - prefix: uploads/levels/
            - suffix: .json
          existing: true
      
      - s3:
          bucket: ${env:ASSETS_BUCKET}
          event: s3:ObjectCreated:*
          rules:
            - prefix: uploads/quests/
            - suffix: .json
          existing: true
```

---

## src/userFunction/function.yml

```yaml
postConfirmUser:
  handler: src/userFunction/profileService.handleInitUser
  events:
    - cognitoUserPool:
        pool: ${env:USER_POOL_NAME}
        trigger: PostConfirmation
        existing: true
        
updateProfile:
  handler: src/userFunction/profileService.handleUpdateProfile
  events:
    - httpApi:
        path: /update-profile
        method: put
        authorizer:
          name: myCognitoAuth

equipCosmetics:
  handler: src/userFunction/profileService.handleEquipCosmetics
  events:
    - httpApi:
        path: /change-cosmetics
        method: post
        authorizer:
          name: myCognitoAuth

updateAvatar:
  handler: src/userFunction/profileService.handleUploadAvatar
  events:
    - httpApi:
        path: /update-avatar
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/sessionFunction/function.yml

```yaml
startStudySession:
  handler: src/sessionFunction/studySessionService.handleStartSession
  events:
    - httpApi:
        path: /start-study-session
        method: post
        authorizer:
          name: myCognitoAuth

recordStrike:
  handler: src/sessionFunction/studySessionService.handleRecordStrike
  events:
    - httpApi:
        path: /strike
        method: post
        authorizer:
          name: myCognitoAuth

endStudySession:
  handler: src/sessionFunction/studySessionService.handleEndSession
  events:
    - httpApi:
        path: /end-study-session
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/currencyFunction/function.yml

```yaml
convertPoints:
  handler: src/currencyFunction/currencyService.handleConvertKPointToKCore
  events:
    - httpApi:
        path: /convert-points
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/gachaFunction/function.yml

```yaml
gacha:
  handler: src/gachaFunction/gachaService.handleGacha
  events:
    - httpApi:
        path: /gacha
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/minigameFunction/function.yml

```yaml
getSudokuLevels:
  handler: src/minigameFunction/minigameService.handleGetSudokuLevels
  events:
    - httpApi:
        path: /minigame/sudokulevels
        method: get
        authorizer:
          name: myCognitoAuth

startGameSession:
  handler: src/minigameFunction/minigameService.handleStartSession
  events:
    - httpApi:
        path: /minigame/sudokulevels/start-game
        method: post
        authorizer:
          name: myCognitoAuth

checkSudokuBoard:
  handler: src/minigameFunction/minigameService.handleCheckSudokuBoard
  events:
    - httpApi:
        path: /minigame/sudokulevels/check
        method: post
        authorizer:
          name: myCognitoAuth

endSudokuSession:
  handler: src/minigameFunction/minigameService.handleEndSudokuSession
  events:
    - httpApi:
        path: /minigame/sudokulevels/end-session
        method: post
        authorizer:
          name: myCognitoAuth

getLeaderboard:
  handler: src/minigameFunction/minigameService.handleGetLeaderboard
  events:
    - httpApi:
        path: /minigame/leaderboard
        method: get
        authorizer:
          name: myCognitoAuth

leaderboardWorker:
  handler: src/minigameFunction/minigameService.handleLeaderboardWorker
  events:
    - schedule:
        description: Trigger update leaderboard moi 10 phut
        rate: rate(10 minutes)
```

---

## src/questFunction/function.yml

```yaml
getDaily:
  handler: src/questFunction/questService.handleGetDaily
  events:
    - httpApi:
        path: /daily
        method: get
        authorizer:
          name: myCognitoAuth

claimQuest:
  handler: src/questFunction/questService.handleClaimQuest
  events:
    - httpApi:
        path: /daily/claim
        method: post
        authorizer:
          name: myCognitoAuth

quizSubmit:
  handler: src/questFunction/questService.handleQuizSubmit
  events:
    - httpApi:
        path: /study-planner/quiz-submit
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/shopFunction/function.yml

```yaml
refresheCoinShop:
  handler: src/shopFunction/shopService.handleRefresheCoinShop
  events:
    # cron(Phút Giờ Ngày-trong-tháng Tháng Ngày-trong-tuần Năm)
    # 0 17 ? * SUN * = 17:00 Chủ Nhật UTC = 00:00 Thứ 2 VN
    - schedule: 
        description: Trigger refresh shop moi tuan vao 0h sang Thu 2 gio VN
        rate: cron(0 17 ? * SUN *)

geteCoinShop:
  handler: src/shopFunction/shopService.handleGeteCoinShop
  events:
    - httpApi:
        path: /shop/ecoin
        method: get
        authorizer:
          name: myCognitoAuth

buyeCoinItem:
  handler: src/shopFunction/shopService.handleBuyeCoinItem
  events:
    - httpApi:
        path: /shop/ecoin/buy
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/socialFunction/function.yml

```yaml
searchUser:
  handler: src/socialFunction/searchService.handleSearchUser
  events:
    - httpApi:
        path: /friends/search
        method: get
        authorizer:
          name: myCognitoAuth

streamIndexer:
  handler: src/socialFunction/searchService.handleStreamIndexer
  events:
    - stream:
        type: dynamodb
        arn: ${env:USER_TABLE_STREAM_ARN}
        startingPosition: TRIM_HORIZON
        batchSize: 10
        enabled: true

getFriends:
  handler: src/socialFunction/friendService.handleGetFriends
  events:
    - httpApi:
        path: /friends
        method: get
        authorizer:
          name: myCognitoAuth

sendFriendRequest:
  handler: src/socialFunction/friendService.handleSendFriendRequest
  events:
    - httpApi:
        path: /friends/request
        method: post
        authorizer:
          name: myCognitoAuth

acceptFriendRequest:
  handler: src/socialFunction/friendService.handleAcceptFriendRequest
  events:
    - httpApi:
        path: /friends/accept
        method: post
        authorizer:
          name: myCognitoAuth

removeFriend:
  handler: src/socialFunction/friendService.handleRemoveFriend
  events:
    - httpApi:
        path: /friends/remove
        method: post
        authorizer:
          name: myCognitoAuth
```

---

## src/syncFunction/function.yml

```yaml
syncAll:
  handler: src/syncFunction/syncService.handleSyncAll
  events:
    - httpApi:
        path: /sync-all
        method: post
        authorizer:
          name: myCognitoAuth

syncProfile:
  handler: src/syncFunction/syncService.handleSyncProfile
  events:
    - httpApi:
        path: /sync-profile
        method: get
        authorizer:
          name: myCognitoAuth

syncInventory:
  handler: src/syncFunction/syncService.handleSyncInventory
  events:
    - httpApi:
        path: /sync-inventory
        method: get
        authorizer:
          name: myCognitoAuth

syncGachaHistory:
  handler: src/syncFunction/syncService.handleSyncGachaHistory
  events:
    - httpApi:
        path: /sync-gacha-history
        method: get
        authorizer:
          name: myCognitoAuth

syncSocial:
  handler: src/syncFunction/syncService.handleSyncSocial
  events:
    - httpApi:
        path: /sync-social
        method: get
        authorizer:
          name: myCognitoAuth

getMasterData:
  handler: src/syncFunction/syncService.handleGetMasterData
  events:
    - httpApi:
        path: /master-data
        method: get
        authorizer:
          name: myCognitoAuth

checkVersion:
  handler: src/syncFunction/syncService.handleCheckVersion
  events:
    - httpApi:
        path: /version
        method: get
```

---

## Tổng kết API Routes

| Method | Path | Handler | Auth | Trigger |
|--------|------|---------|------|---------|
| POST | /sync-all | syncService.handleSyncAll | ✅ | HTTP |
| GET | /sync-profile | syncService.handleSyncProfile | ✅ | HTTP |
| GET | /sync-inventory | syncService.handleSyncInventory | ✅ | HTTP |
| GET | /sync-gacha-history | syncService.handleSyncGachaHistory | ✅ | HTTP |
| GET | /sync-social | syncService.handleSyncSocial | ✅ | HTTP |
| GET | /master-data | syncService.handleGetMasterData | ✅ | HTTP |
| GET | /version | syncService.handleCheckVersion | ❌ | HTTP |
| — | PostConfirmation | profileService.handleInitUser | — | Cognito |
| PUT | /update-profile | profileService.handleUpdateProfile | ✅ | HTTP |
| POST | /change-cosmetics | profileService.handleEquipCosmetics | ✅ | HTTP |
| POST | /update-avatar | profileService.handleUploadAvatar | ✅ | HTTP |
| POST | /start-study-session | studySessionService.handleStartSession | ✅ | HTTP |
| POST | /strike | studySessionService.handleRecordStrike | ✅ | HTTP |
| POST | /end-study-session | studySessionService.handleEndSession | ✅ | HTTP |
| POST | /convert-points | currencyService.handleConvertKPointToKCore | ✅ | HTTP |
| POST | /gacha | gachaService.handleGacha | ✅ | HTTP |
| GET | /minigame/sudokulevels | minigameService.handleGetSudokuLevels | ✅ | HTTP |
| POST | /minigame/sudokulevels/start-game | minigameService.handleStartSession | ✅ | HTTP |
| POST | /minigame/sudokulevels/check | minigameService.handleCheckSudokuBoard | ✅ | HTTP |
| POST | /minigame/sudokulevels/end-session | minigameService.handleEndSudokuSession | ✅ | HTTP |
| GET | /minigame/leaderboard | minigameService.handleGetLeaderboard | ✅ | HTTP |
| — | rate(10 minutes) | minigameService.handleLeaderboardWorker | — | EventBridge |
| GET | /daily | questService.handleGetDaily | ✅ | HTTP |
| POST | /daily/claim | questService.handleClaimQuest | ✅ | HTTP |
| POST | /study-planner/quiz-submit | questService.handleQuizSubmit | ✅ | HTTP |
| — | cron(0 17 ? * SUN *) | shopService.handleRefresheCoinShop | — | EventBridge |
| GET | /shop/ecoin | shopService.handleGeteCoinShop | ✅ | HTTP |
| POST | /shop/ecoin/buy | shopService.handleBuyeCoinItem | ✅ | HTTP |
| GET | /friends/search | searchService.handleSearchUser | ✅ | HTTP |
| — | DynamoDB Stream | searchService.handleStreamIndexer | — | Stream |
| GET | /friends | friendService.handleGetFriends | ✅ | HTTP |
| POST | /friends/request | friendService.handleSendFriendRequest | ✅ | HTTP |
| POST | /friends/accept | friendService.handleAcceptFriendRequest | ✅ | HTTP |
| POST | /friends/remove | friendService.handleRemoveFriend | ✅ | HTTP |
| — | s3:ObjectCreated (uploads/items/*.zip) | itemUpload.processZip | — | S3 |
| — | s3:ObjectCreated (uploads/levels/*.json) | jsonUpload.processJson | — | S3 |
| — | s3:ObjectCreated (uploads/quests/*.json) | jsonUpload.processJson | — | S3 |

**Tổng: 20 Lambda functions, 25 HTTP routes, 2 EventBridge schedules, 3 S3 triggers, 1 DynamoDB Stream trigger, 1 Cognito trigger**
