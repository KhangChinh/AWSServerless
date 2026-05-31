minigame, game sudoku màn easy_1, tên màn, số tiền để unlock màn (nếu có), điểm trần, phần thưởng qua màn (50% nếu đã qua màn), layout của map (chỉ mang tính chất tham khảo nên có thể cập nhật thêm tham số - nguyên lí: khi user ấn play thì trừ tiền ở budget đi, sau đó kiểm tra nếu ko có bảng active_game thì tạo 1 bảng active_game thuộc game đó sau đó load seed của màn đã chọn cho client hiện lên, user giải màn theo logic game ở client (lưu lại log mỗi bước đi), khi hoàn thành thì gửi seed của bàn đã giải kèm log bước đi. Server sẽ kiểm tra active_game xem currentLevel để lấy ra solutionGrid so với finalGrid, nếu đúng thì kiểm tra thời gian hiện tại so với startTime có nhanh quá không, sau đó check actionLogs để xem nếu tất cả timestamp có sát nhau không, nếu thỏa thì kiểm tra xem trong score xem có level này chưa, nếu chưa có thì đưa mã level đã hoàn thành và điểm vào, sau đó cộng budget bằng với reward, nếu có rồi thì kiểm tra xem điểm mới có cao hơn điểm cũ ko, nếu có thì update ko thì thôi sau đó cộng budget bằng 50% với reward sau đó xóa bảng active_game đi) 

log mỗi bước đi (không nằm trong DB)
{
  "finalGrid": "534678912672195348198342567859761423426853791713924856961537284287419635345286179",
  "actionLogs": [
    { "cell": [0,2], "value": 4, "timestamp": 1717372810 },
    { "cell": [0,3], "value": 6, "timestamp": 1717372815 },
    // ... thao tác khác
  ]
}