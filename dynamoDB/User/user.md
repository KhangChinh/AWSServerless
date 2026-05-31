{
    userId và information lấy khi initUser, default avatarUrl là 1 ảnh mặc định trên cloudfront
    "PK": "usr_12345",
    "SK": "profile",
    "information": {
        "name": "Nguyễn Văn A",
        "email": "a@example.com",
        "avatarUrl": "https://cloudfront.net/avatar/usr_12345.jpg"
    },
    Có thể đổi tên tiền tệ, gem có thể thêm phần roll để 160 gem = 1 roll hay gì đó
    default: 1600, 0, 0
    "budget": {
        "gems": 1200,
        "coins": 5000,
        "stones": 300
    },
    rankScore là điểm hạng, hệ thống hạng mỗi hạng bao nhiêu điểm cần xác định thêm, lastFocusDate update mỗi khi streak tăng 1
    default: 0, 0, never
    "focusStats": {
        "rankScore": 1500,
        "streak": 5,
        "lastFocusDate": "2026-05-30T00:00:00Z"
    },
    nơi lưu pity của banner
    default: 0, 0, false
    "gacha": {
        "pity4Star": 7,
        "pity5Star": 78,
        "isGuaranteed": false
    },
    những giá trị trong này sẽ là dữ liệu để load giao diện của người dùng
    default: none, none
    "cosmetics": {
        "equippedTheme": "cyberpunk_2077",
        "equippedFrame": "gold_border"
    }
}