`server (aws api gateway + lambda):`
-mọi hàm trên server đều phải có code kiểm tra authorize và lấy userId từ đó ra chứ không nhận userId từ client

-các hàm sync dữ liệu:
    +sync tất cả: nhận updatedAt và inventoryUpdatedAt từ client:
        ~nếu ko có tức là cần lấy hết. tiến hành lấy userId ra để lấy profile của userId đó, lấy inventory của userId đó ra 20 vật phẩm đầu tiên kèm LastEvaluatedKey, server trả profile và inventory kèm LastEvaluatedKey cho client. (LastEvaluatedKey là 1 SK cuối cùng mà server trỏ tới, PK userId sẽ lấy theo đầu hàm của server)
        ~nếu updatedAt và inventoryUpdatedAt của client so với trong profile giống nhau thì ko trả, còn nếu khác cả 2 thì như trường hợp trên
        ~nếu updatedAt khác và inventoryUpdatedAt giống, chỉ lấy thông tin profile của userId đó trả về cho client
        ~nếu updatedAt giống và inventoryUpdatedAt khác, chỉ lấy inventory của userId đó ra 20 vật phẩm đầu tiên kèm LastEvaluatedKey trả về cho client
    +sync profile: kiểm tra và lấy profile của userId đó trả về cho client
    +sync inventory: kiểm tra và lấy 20 vật phẩm đầu tiên trong inventory của userId đó trả về cho client
    +sync gacha history: 

-các hàm profile

-các hàm inventory
    +

`client (reactjs + nodejs + electron):`
-mọi thao tác từ client đến server đều phải được xác thực đúng người dùng thực hiện thao tác, khi react gửi request cho api gateway phải gửi kèm header có bearer access token,
-mọi dữ liệu lưu vào electron-store đều phải mã hóa qua safe storage

-khi người dùng đăng ký tài khoản (name, email, password) sẽ được aws cognito gửi mã xác thực về gmail, sau khi người dùng nhập đúng mã xác thực thì aws lambda sẽ trigger 1 PostConfirmation để lấy thông tin người dùng đó từ congito và khởi tạo 1 [profile](Table/User/profile.json) cho người dùng

-khi người dùng đăng nhập vào tài khoản:
    +cognito trả về refresh token và access token để sử dụng, lưu refresh token vào electron-store
    +gọi api sync tất cả, lưu thông tin profile và inventory mới nhất kèm LastEvaluatedKey từ server vào electron store  
    +gọi api lấy thông tin người dùng, đồng thời lưu vào electron-store ko mã hóa và redux,
    +gọi api lấy thông tin túi đồ của người dùng, server lấy tất cả item trong table inventory thuộc userId đó gộp ra danh sách trả về client, client lưu vào electron-store ko mã hóa và redux
     +kiểm tra equipped theme, frame, title đang sử dụng, kiểm tra đã có trên máy chưa, nếu có rồi thì tiến hành load ra giao diện, chưa thì đưa cho server để hỏi presignedUrl để tải theme, frame, title tương ứng lưu về và load ra

-khi người dùng đăng xuất khỏi tài khoản:

