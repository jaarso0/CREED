using System;

namespace Fixture.Data
{
    public interface IUserRepo
    {
        void Insert(string name);
    }

    public enum Status { Active, Inactive }

    public struct Point
    {
        public int X;
    }

    public class UserRepo : IUserRepo
    {
        private readonly int _limit;

        public UserRepo(int limit)
        {
            _limit = limit;
        }

        public void Insert(string name)
        {
            Console.WriteLine(name);
        }
    }
}
