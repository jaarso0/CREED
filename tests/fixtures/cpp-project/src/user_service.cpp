#include "user_repo.h"
#include <string>

namespace fixture {

class UserService {
public:
    int Save(const std::string& name);
private:
    UserRepo* repo_;
};

int UserService::Save(const std::string& name) {
    User* u = new User();
    return repo_->Insert(name);
}

void freeHelper(int a) {
}

}
