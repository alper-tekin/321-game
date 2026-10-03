# 3-2-1 Futbol

İki kişilik, ayrı cihazlardan oynanan futbol bilgi oyunu. Geri sayımdan sonra iki oyuncu birer takım açıklar;
**iki takımda da oynamış** bir futbolcuyu ilk yazan puanı alır.

## Çalıştırma

```bash
npm install
npm start
```

Oyun `http://localhost:3210` adresinde açılır. Aynı Wi-Fi'daki telefondan bilgisayarın yerel IP adresiyle girilebilir.

## Veri

Veri üç açık kaynaktan birleşir (`npm run build-data`, birkaç dakika sürer):

1. **[Wikidata](https://www.wikidata.org)** (CC0) — kulüpler, oyuncular, tarihi kulüp kayıtları,
   Türkçe/İngilizce isim ve takma adlar
2. **[Transfermarkt transfer geçmişi](https://github.com/dcaribou/transfermarkt-datasets)** (CC0) —
   Wikidata'nın kaçırdığı tarihi transferler (veri seti 6 Temmuz 2026'ya kadar)
3. **Wikipedia güncel kadroları** (CC BY-SA) — kulüplerin İngilizce Wikipedia kadro şablonları;
   yeni transferler burada hızla güncellenir

Wikidata bazen güncel transferleri geç işler. `data/overrides.json` dosyasıyla eksik kulüp kayıtları
elle eklenebilir (örn. Trossard'ın Beşiktaş transferi). Düzenledikten sonra `npm run build-data`
çalıştırın. Wikidata kaydı düzeldiğinde override'ı kaldırmak yeterli.

## Test

```bash
npm test
```

## Yayınlama

`render.yaml` ile [Render](https://render.com) ücretsiz planına yüklenebilir.
