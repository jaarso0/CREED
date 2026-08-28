#ifndef USER_REPO_H
#define USER_REPO_H

#include <string>

namespace fixture {

struct User {
    std::string name;
};

enum Color { Red, Green };

class UserRepo {
public:
    UserRepo();
    int Insert(const std::string& name);
private:
    int count_;
};

}
#endif
