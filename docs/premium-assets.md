# 💎 购买素材接入指南（高级素材热替换）

购买的精品模型（Unity 商店 / Fab / CGTrader 等）**不要提交到本公开仓库**（违反素材授权）。
正确做法：直接上传到你的腾讯云服务器，游戏会自动优先加载。

## 上传位置

通过 OrcaTerm 左上角 SFTP（或 scp）把文件传到服务器：

```
/opt/dimensional-war-3d/public/assets/premium/
├── manifest.json        ← 声明要替换哪些模型
├── heroes/
│   ├── warrior.glb
│   └── ...
└── monsters/
    └── ...
```

该目录不会被 Git 管理，也不会被重新部署覆盖（部署脚本只新增不删除）。

## manifest.json 格式

`overrides` 的 key 是游戏内部模型键名，可替换任意一部分，没写的继续用默认模型：

```json
{
  "overrides": {
    "hero_hunter":  { "url": "heroes/warrior.glb",
                      "animMap": { "Idle": "idle", "Running_A": "run",
                                   "Death_A": "die", "Dodge_Forward": "roll",
                                   "1H_Melee_Attack_Slice_Diagonal": "attack01",
                                   "2H_Melee_Attack_Slice": "attack02",
                                   "Spellcast_Shoot": "skill01",
                                   "2H_Melee_Attack_Spin": "skill02",
                                   "2H_Melee_Attack_Slice": "skill03" } },
    "hero_xiuxian": { "url": "heroes/assassin.glb", "animMap": { } },
    "mon_t1":       { "url": "monsters/t1.glb",     "animMap": { } }
  }
}
```

- 模型键名清单：英雄 `hero_tech / hero_xiuxian / hero_cyber / hero_magic / hero_hunter`
  （对应职业 坦克/刺客/射手/奶妈/战士 的基础模型）；怪物 `mon_t1 ~ mon_t4`；
  场景摆件 `prop_主题_名称`（见 `public/js/models.js` 的 PROP_DEFS）
- `animMap`：左边是游戏需要的动作名，右边填你的模型里实际的动画片段名
  （不知道叫什么就把 glb 发给 Claude 看，或留空 `{}` 先看模型效果）
- 模型要求：GLB 格式、带骨骼动画、单文件 ≤ 8MB 为佳（网页加载速度）

## 格式转换

买到的是 FBX / .unitypackage？把文件交给 Claude（上传或放到服务器临时目录），
由 Claude 完成 FBX→GLB 转换、动画重命名和 manifest 编写。

## 验证

上传后强制刷新游戏页面即可看到新模型。浏览器控制台（F12）会打印每个素材的加载来源，
加载失败会自动回退默认模型，不会黑屏。
